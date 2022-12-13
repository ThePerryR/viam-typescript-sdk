import * as robotApi from './gen/robot/v1/robot_pb'
import {
  Code,
  ConnectError,
  PromiseClient,
  createGrpcWebTransport,
  createPromiseClient
} from '@bufbuild/connect-web'
import { ConnectionClosedError } from '@viamrobotics/rpc'
import { RobotService } from './gen/robot/v1/robot_connectweb'
import SessionTransport from './SessionTransport'
import { grpc } from '@improbable-eng/grpc-web'

const timeoutBlob = new Blob(
  [
    `self.onmessage = function(e) {
  setTimeout(() => self.postMessage(""), e.data);
};`,
  ],
  { type: 'text/javascript' }
)

export default class SessionManager {
  private readonly innerTransportFactory: grpc.TransportFactory

  private client: PromiseClient<typeof RobotService>

  private currentSessionID = ''
  private sessionsSupported: boolean | undefined
  private heartbeatIntervalMs: number | undefined

  private starting: Promise<void> | undefined

  private startResolve: (() => void) | undefined

  private startReject: ((reason: ConnectError) => void) | undefined

  constructor (serviceHost: string, transportFactory: grpc.TransportFactory) {
    this.innerTransportFactory = transportFactory
    const transport = createGrpcWebTransport({ baseUrl: serviceHost })
    this.client = createPromiseClient(RobotService, transport)
  }

  get transportFactory () {
    return (opts: grpc.TransportOptions): grpc.Transport => {
      return new SessionTransport(opts, this.innerTransportFactory, this)
    }
  }

  get sessionID () {
    return this.currentSessionID
  }

  private getSessionMetadataInner (): grpc.Metadata {
    const md = new grpc.Metadata()
    if (this.sessionsSupported && this.currentSessionID !== '') {
      md.set('viam-sid', this.currentSessionID)
    }
    return md
  }

  public reset () {
    if (this.starting) {
      return
    }
    this.sessionsSupported = undefined
  }

  // Note: maybe support non-worker for foreground presence.
  private readonly backgroundHeartbeat = true

  private async heartbeat () {
    if (!this.sessionsSupported || this.currentSessionID === '') {
      return
    }
    while (this.starting) {
      // eslint-disable-next-line no-await-in-loop
      await this.starting
    }

    let worker: Worker | undefined
    const doHeartbeat = async () => {
      const sendHeartbeatReq = new robotApi.SendSessionHeartbeatRequest({
        id: this.currentSessionID,
      })
      try {
        await this.client.sendSessionHeartbeat(sendHeartbeatReq)
      } catch (err) {
        if (err) {
          if (ConnectionClosedError.isError(err)) {
            /*
             * We assume the connection closing will cause getSessionMetadata to be
             * called again by way of a reset.
             */
            this.reset()
          }
          // Otherwise we want to continue in case it was just a blip
        }
      }

      if (worker) {
        worker.postMessage(this.heartbeatIntervalMs)
      } else {
        setTimeout(() => doHeartbeat(), this.heartbeatIntervalMs)
      }
    }

    /*
     * This lint is correct but it makes our lives easier to refer to a boolean in
     * case in the future we make this toggleable (e.g. foreground).
     */
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (this.backgroundHeartbeat && window.Worker) {
      const url = window.URL.createObjectURL(timeoutBlob)
      worker = new Worker(url)
      URL.revokeObjectURL(url)
      worker.onmessage = function () {
        doHeartbeat()
      }
    }

    doHeartbeat()
  }

  public async getSessionMetadata (): Promise<grpc.Metadata> {
    while (this.starting) {
      // eslint-disable-next-line no-await-in-loop
      await this.starting
    }
    if (this.sessionsSupported !== undefined) {
      return this.getSessionMetadataInner()
    }
    this.starting = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve
      this.startReject = reject
    })

    try {
      const startSessionReq = new robotApi.StartSessionRequest()
      if (this.currentSessionID !== '') {
        startSessionReq.resume = this.currentSessionID
      }
      let resp: robotApi.StartSessionResponse | undefined
      try {
        resp = await this.client.startSession(startSessionReq)
      } catch (error) {
        const err = error as ConnectError
        if (err.code === Code.Unimplemented) {
          console.error('sessions unsupported; will not try again')
          this.sessionsSupported = false
          this.startResolve?.()
        } else {
          this.startReject?.(err)
        }
      }

      if (!resp) {
        this.startReject?.(new ConnectError('expected response to start session', Code.Internal))
        // TODO: this isn't right - it just satisfies the return type of this function
        return new grpc.Metadata()
      }

      const heartbeatWindow = resp.heartbeatWindow
      if (!heartbeatWindow) {
        this.startReject?.(new ConnectError(
          'expected heartbeat window in response to start session',
          Code.Internal
        ))
        // TODO: this isn't right - it just satisfies the return type of this function
        return new grpc.Metadata()
      }

      this.sessionsSupported = true
      this.currentSessionID = resp.id
      this.heartbeatIntervalMs =
        (heartbeatWindow.seconds * 1e3 + heartbeatWindow.nanos / 1e6) / 5
      this.startResolve?.()
      this.heartbeat()

      await this.starting
      return this.getSessionMetadataInner()
    } finally {
      this.startResolve?.()
      this.startResolve = undefined
      this.startReject = undefined
      this.starting = undefined
    }
  }
}
