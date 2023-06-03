/* eslint-disable no-underscore-dangle */
import { FunctionComponent, useCallback, useEffect, useRef } from 'react'
import { useRecoilState, useRecoilValue, useSetRecoilState } from 'recoil'
import Peer from 'simple-peer'
import { MAX_BANDWIDTH, MIN_BANDWIDTH } from '../../utils/settings'
import { transformSdp, blankVideo } from '../../utils/helpers'
import {
    addMessageSelector,
    preferencesState,
    remoteStreamsState,
    socketState,
    userStreamState,
    PeerData,
    Message,
    displayStreamState,
    addRemoteStreamsSelector,
    RemoteStream,
} from '../../atoms'
import { MoozPeer } from '../../react-app-env'
import toast, { Timeout, ToastType } from '../../comps/toast'

interface SignalMessage {
    from: string
    signal?: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

interface PeerProps extends Peer.Options {
    partnerId: string
    partnerName?: string
}

interface PeerInternals extends Peer.Instance {
    _remoteStreams?: MediaStream[]
    _remoteTracks?: {
        stream: MediaStream
        track: MediaStreamTrack
    }[]
    _connected?: boolean
}

type ErrorCodes =
    | 'ERR_WEBRTC_SUPPORT'
    | 'ERR_CREATE_OFFER'
    | 'ERR_CREATE_ANSWER'
    | 'ERR_SET_LOCAL_DESCRIPTION'
    | 'ERR_SET_REMOTE_DESCRIPTION'
    | 'ERR_ADD_ICE_CANDIDATE'
    | 'ERR_ICE_CONNECTION_FAILURE'
    | 'ERR_SIGNALING'
    | 'ERR_DATA_CHANNEL'
    | 'ERR_CONNECTION_FAILURE'

interface PeerError {
    code: ErrorCodes
}

const createSdpTransform = (badwidth: number) => (sdp: string) => transformSdp(sdp, badwidth)

const PeerComponent: FunctionComponent<PeerProps> = props => {
    const addMessage = useSetRecoilState(addMessageSelector)
    const addRemoteStreams = useSetRecoilState(addRemoteStreamsSelector)
    const preferences = useRecoilValue(preferencesState)
    const { partnerId, partnerName, ...opts } = props
    const [remoteStreams, setRemoteStreams] = useRecoilState(remoteStreamsState)
    const remoteStreamRef = useRef(new MediaStream())
    const userStream = useRecoilValue(userStreamState)
    const displayStream = useRecoilValue(displayStreamState)

    const socket = useRecoilValue(socketState)

    const peerRef = useRef<Peer.Instance>()
    if (!peerRef.current) {
        const LEN = (window.moozPeers?.length || 0) + 1
        let bandwidth = MAX_BANDWIDTH / Math.sqrt(LEN)
        if (bandwidth < MIN_BANDWIDTH) bandwidth = MIN_BANDWIDTH
        peerRef.current = new Peer({
            // eslint-disable-next-line
            sdpTransform: createSdpTransform(bandwidth) as any,
            ...opts,
        })
    }

    const saveInstance = () => {
        const peer = peerRef.current as Peer.Instance
        const moozPeer: MoozPeer = { peer, partnerId }
        if (!window.moozPeers) window.moozPeers = [moozPeer]

        window.moozPeers = window.moozPeers.filter(p => p.partnerId !== partnerId)

        window.moozPeers.push(moozPeer)
    }
    saveInstance()

    const onMetaData = useCallback(
        (str: string) => {
            try {
                const data: PeerData = JSON.parse(str)
                if (data.metadata?.state === 'NO_STREAM') {
                    remoteStreamRef.current.getTracks().forEach(t => {
                        t.stop()
                        remoteStreamRef.current.removeTrack(t)
                    })
                    setRemoteStreams(remoteStreams.filter(r => r.partnerId !== partnerId))
                }
            } catch (err) {
                console.log(err)
            }
        },
        [remoteStreams, setRemoteStreams, partnerId],
    )

    const onRemoteStream = useCallback(
        (stream: MediaStream, dontStopPrev?: boolean) => {
            const remoteStream = remoteStreamRef.current
            if (!dontStopPrev) {
                remoteStream.getTracks().forEach(t => {
                    if (t.kind === 'video') t.stop()
                    remoteStream.removeTrack(t)
                })
            }
            const toAdd: RemoteStream[] = []

            const videoTracks = stream.getVideoTracks()
            const displayTrack = videoTracks[1] as MediaStreamTrack | undefined // TODO 1?

            if (displayTrack) {
                stream.removeTrack(displayTrack)
                const rdStream = new MediaStream([displayTrack])
                if (
                    remoteStreams.find(
                        rs =>
                            rs.isDisplay &&
                            rs.partnerId === partnerId &&
                            rs.stream
                                .getVideoTracks()
                                .find(
                                    vt =>
                                        vt.id === displayTrack.id &&
                                        vt.enabled &&
                                        vt.readyState === 'live',
                                ),
                    )
                )
                    return

                toAdd.push({ stream: rdStream, isDisplay: true, partnerId, partnerName })
            }

            stream.getTracks().forEach(t => {
                if (dontStopPrev && remoteStream.getTracks().find(rt => rt.id === t.id)) return
                remoteStream.addTrack(t)
            })

            toAdd.unshift({
                stream: remoteStream,
                partnerId,
                partnerName,
            })

            addRemoteStreams(toAdd)
        },
        [addRemoteStreams, remoteStreams, partnerId, partnerName],
    )

    const onTrack = useCallback(
        (track: MediaStreamTrack, stream: MediaStream) => {
            const pr = window.moozPeers?.find(p => p.partnerId === partnerId)?.peer as
                | PeerInternals
                | undefined

            const currStream = pr?._remoteStreams?.find(r => r.active)
            if (!currStream || currStream.id !== stream.id) return

            let tr =
                pr?._remoteTracks
                    ?.filter(({ stream: s }) => s.id === currStream.id)
                    .map(o => o.track)
                    .filter(t => t.enabled && t.readyState === 'live') || []

            if (!tr.find(t => t.id === track.id)) {
                tr = tr.concat(track)
            }

            const compTr = [
                ...remoteStreamRef.current.getTracks(),
                remoteStreams
                    .find(r => r.isDisplay && r.partnerId === partnerId)
                    ?.stream.getVideoTracks()[0],
            ].filter(Boolean) as MediaStreamTrack[]

            if (tr.length > compTr.length) {
                const strm = new MediaStream(tr)
                onRemoteStream(strm, true)
            }
        },
        [onRemoteStream, remoteStreams, partnerId],
    )

    useEffect(() => {
        const peer = peerRef.current as Peer.Instance
        const onMessageRecieved = (msg: SignalMessage) => {
            const { signal, from } = msg
            if (signal && from === partnerId) {
                try {
                    peer.signal(signal)
                } catch (err) {
                    console.log(err)
                }
            }
        }
        const onConnected = () => {
            toast(`Connected with peer ${partnerName}`, { type: ToastType.success })
        }
        const onClose = () => {
            toast(`Connection closed with peer ${partnerName}`, { type: ToastType.severeWarning })
            socket.emit('person_left', { sessionId: partnerId })
        }
        const onError = (err: PeerError) => {
            if (err.code === 'ERR_WEBRTC_SUPPORT') {
                toast(`No WebRTC support, are you on grandpa's computer?`, {
                    type: ToastType.error,
                })
            } else if (err.code === 'ERR_CONNECTION_FAILURE') {
                toast(`WebRTC connection failure`, {
                    type: ToastType.error,
                })
            }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const onLocalSignal = (signal: any) => {
            socket.send({
                to: partnerId,
                signal,
            })
        }
        const onDataRecieved = (str: string) => {
            try {
                const data: PeerData = JSON.parse(str)
                if (data.message) {
                    const msg: Message = {
                        ...data.message,
                        mine: false,
                    }
                    addMessage([msg])
                    toast(`New message from ${msg.author}: ${msg.text}`, {
                        type: ToastType.info,
                    })
                }
            } catch (err) {
                toast(`Peer data error`, {
                    type: ToastType.error,
                    autoClose: Timeout.SHORT,
                })
            }
        }

        peer.on('stream', onRemoteStream)
        peer.on('signal', onLocalSignal)
        peer.on('data', onDataRecieved)
        peer.on('data', onMetaData)
        peer.on('connect', onConnected)
        peer.on('close', onClose)
        peer.on('error', onError)
        peer.on('track', onTrack)

        socket.on('message', onMessageRecieved)

        return () => {
            peer.off('stream', onRemoteStream)
            peer.off('signal', onLocalSignal)
            peer.off('connect', onConnected)
            peer.off('data', onDataRecieved)
            peer.off('data', onMetaData)
            peer.off('close', onClose)
            peer.off('error', onError)
            peer.off('track', onTrack)

            socket.off('message', onMessageRecieved)
        }
    }, [onRemoteStream, socket, partnerId, addMessage, onMetaData, onTrack, partnerName])

    useEffect(() => {
        const peer = peerRef.current as Peer.Instance

        const displayVideoTracks = displayStream?.getVideoTracks()
        const tracks = [...(userStream?.getTracks() || []), ...(displayVideoTracks || [])]
        if (displayVideoTracks?.length && !userStream?.getVideoTracks().length) {
            tracks.unshift(blankVideo())
        }
        const stream = new MediaStream(tracks)
        try {
            if (!tracks.length) {
                const msg: PeerData = { metadata: { state: 'NO_STREAM' } }
                peer.send(JSON.stringify(msg))
            } else {
                peer.addStream(stream)
            }
        } catch (err) {
            console.log(err)
        }
        return () => {
            try {
                peer.removeStream(stream)
            } catch (err) {
                console.log(err)
            }
        }
    }, [userStream, displayStream])

    useEffect(() => {
        if (!opts.initiator) {
            socket.send({
                to: partnerId,
                proposal: true,
                name: preferences.name,
            })
        }
    }, []) // eslint-disable-line

    useEffect(
        () => () => {
            peerRef.current?.destroy()
            remoteStreamRef.current.getTracks().forEach(t => {
                t.stop()
                remoteStreamRef.current.removeTrack(t)
            })
        },
        [],
    )

    return null
}

export default PeerComponent
