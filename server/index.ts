import { createServer } from 'http'
import { Server, Socket } from 'socket.io'
import { nanoid } from 'nanoid'
import NodeCache from 'node-cache'

const IO_OPTIONS = {
    cors: {
        origin: JSON.parse(process.env.ALLOW_ORIGIN || '"*"'),
        credentials: !!process.env.ALLOW_ORIGIN,
    },
}

const httpServer = createServer()
const io = new Server(httpServer, IO_OPTIONS)

const roomsCache = new NodeCache({
    stdTTL: 43200,
})

interface Room {
    id: string
    created_by?: string
    name?: string
    opts?: {
        maxPeople?: string
    }
}

interface Person {
    sessionId: string
}

io.on('connection', (socket: Socket) => {
    console.log('socket connected', socket.id)

    socket.on('register', ({ sessionId, roomId }: { sessionId: string; roomId?: string }) => {
        roomsCache.set<Person>(socket.id, { sessionId })

        socket.join(sessionId)

        if (roomId) {
            socket.join(roomId)
            io.to(roomId).emit('person_reconnected', {
                sessionId,
            })
        }
    })

    socket.on('create_room', (room: Room, cb) => {
        try {
            const roomId = nanoid()
            room.id = roomId

            socket.join(roomId)
            roomsCache.set<Room>(roomId, room)
            io.to(socket.id).emit('joined_room', room)

            cb({ isError: false })
        } catch (err) {
            console.error(err)
            cb({ isError: true })
        }
    })

    socket.on('join_room', async (opts, cb) => {
        try {
            const { name, link } = opts
            const room = getRoomFromLink(link)

            if (!room) {
                cb({ error: 'Room not found or invalid input!' })
                return
            }
            const maxPeople = parseInt(room.opts?.maxPeople || '')
            const sockets = await io.in(room.id).allSockets()
            const peopleCount = sockets.size
            if (!isNaN(maxPeople) && peopleCount >= maxPeople) {
                cb({ error: 'Specified room participants limit reached, make a new one!' })
                return
            }

            const { sessionId } = roomsCache.get<Person>(socket.id) || {}
            if (!sessionId) throw Error('No session id')

            socket.join(room.id)
            socket.to(room.id).emit('person_joined', {
                name,
                sessionId,
            })
            io.to(socket.id).emit('joined_room', room)

            cb({ error: undefined })
        } catch (err) {
            console.error('Error creating room', err)
            cb({ error: 'Something went wrong, try again later.' })
        }
    })

    socket.on('leave_room', () => {
        try {
            socket.rooms.forEach(room => {
                const { sessionId } = roomsCache.get<Person>(socket.id) || {}

                if (room === socket.id || room === sessionId) return

                socket.leave(room)

                if (sessionId) {
                    socket.to(room).emit('person_left', {
                        sessionId,
                    })
                }
                io.in(room)
                    .allSockets()
                    .then(sockets => {
                        if (sockets.size === 0) {
                            roomsCache.del(room)
                        }
                    })
            })
        } catch (err) {
            console.error('Error leaving room 😂', err)
        }
    })

    socket.on('person_left', ({ sessionId }: { sessionId: string }) => {
        try {
            io.to(sessionId).emit('leave_room')
            socket.rooms.forEach(room => {
                if (room === socket.id) return
                const { sessionId: mySessionId } = roomsCache.get<Person>(socket.id) || {}
                if (room === mySessionId) return

                io.to(room).emit('person_left', {
                    sessionId,
                })
            })
        } catch (err) {
            console.error('Error leaving room 😂', err)
        }
    })

    socket.on('message', message => {
        const { to, ...msg } = message
        const { sessionId } = roomsCache.get<Person>(socket.id) || {}
        if (!sessionId) return
        socket.to(to).send({
            from: sessionId,
            ...msg,
        })
    })

    socket.on('disconnecting', () => {
        const { sessionId } = roomsCache.get<Person>(socket.id) || {}
        roomsCache.del(socket.id)
        socket.rooms.forEach(room => {
            if (room !== socket.id || room !== sessionId) {
                if (sessionId) {
                    io.to(room).emit('person_disconnected', {
                        sessionId,
                    })
                }
            }
        })
    })
})
const PATH_REGEX = /^\/room\/(?<id>[A-Za-z0-9_-]+$)/
const ID_REGEX = /^(?<id>[A-Za-z0-9_-]+$)/

function getRoomFromLink(link: string): Room | undefined {
    let id: string | undefined
    try {
        const url = new URL(link)
        id = url.pathname.match(PATH_REGEX)?.groups?.id
    } catch (error) {
        id = link.match(ID_REGEX)?.groups?.id
    }

    return id !== undefined ? roomsCache.get(id) : undefined
}

httpServer.listen(process.env.PORT || 5001, () => {
    console.log('listening on port', process.env.PORT || 5001)
})
