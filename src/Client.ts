/* eslint-disable max-classes-per-file */
import type { Credentials, DialOptions } from '@viamrobotics/rpc/src/dial'
import { dialDirect, dialWebRTC } from '@viamrobotics/rpc'
import SessionManager from './SessionManager'
import type { grpc } from '@improbable-eng/grpc-web'

interface WebRTCOptions {
  enabled: boolean
  host: string
  signalingAddress: string
  rtcConfig: RTCConfiguration | undefined
}

interface SessionOptions {
  disabled: boolean
}

abstract class ServiceClient {
  constructor (public serviceHost: string, public options?: grpc.RpcOptions) {}
}

export default class Client {
  private readonly serviceHost: string
  private readonly webrtcOptions: WebRTCOptions | undefined
  private readonly sessionOptions: SessionOptions | undefined
  private sessionManager: SessionManager

  private peerConn: RTCPeerConnection | undefined

  private transportFactory: grpc.TransportFactory | undefined

  private connecting: Promise<void> | undefined

  private connectResolve: (() => void) | undefined

  private savedAuthEntity: string | undefined

  private savedCreds: Credentials | undefined

  constructor (serviceHost: string, webrtcOptions?: WebRTCOptions, sessionOptions?: SessionOptions) {
    this.serviceHost = serviceHost
    this.webrtcOptions = webrtcOptions
    this.sessionOptions = sessionOptions
    this.sessionManager = new SessionManager(serviceHost, (opts: grpc.TransportOptions): grpc.Transport => {
      if (!this.transportFactory) {
        throw new Error(Client.notConnectedYetStr)
      }
      return this.transportFactory(opts)
    })
  }

  get sessionId () {
    return this.sessionManager.sessionID
  }

  private static readonly notConnectedYetStr = 'not connected yet'

  createServiceClient<T extends ServiceClient> (SC: new (serviceHost: string, options?: grpc.RpcOptions) => T): T {
    const clientTransportFactory = this.sessionOptions?.disabled
      ? this.transportFactory
      : this.sessionManager.transportFactory

    if (!clientTransportFactory) {
      throw new Error(Client.notConnectedYetStr)
    }
    const grpcOptions = { transport: clientTransportFactory }
    return new SC(this.serviceHost, grpcOptions)
  }

  get host () {
    const clientTransportFactory = this.sessionOptions?.disabled
      ? this.transportFactory
      : this.sessionManager.transportFactory

    if (!clientTransportFactory) {
      throw new Error(Client.notConnectedYetStr)
    }
    return this.serviceHost
  }

  public async disconnect () {
    while (this.connecting) {
      // eslint-disable-next-line no-await-in-loop
      await this.connecting
    }

    if (this.peerConn) {
      this.peerConn.close()
      this.peerConn = undefined
    }
    this.sessionManager.reset()
  }

  public async connect (authEntity = this.savedAuthEntity, creds = this.savedCreds) {
    if (this.connecting) {
      // This lint is clearly wrong due to how the event loop works such that after an await, the condition may no longer be true.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      while (this.connecting) {
        // eslint-disable-next-line no-await-in-loop
        await this.connecting
      }
      return
    }
    this.connecting = new Promise<void>((resolve) => {
      this.connectResolve = resolve
    })

    if (this.peerConn) {
      this.peerConn.close()
      this.peerConn = undefined
    }

    /*
     * TODO(RSDK-887): no longer reset if we are reusing authentication material; otherwise our session
     * and authentication context will no longer match.
     */
    this.sessionManager.reset()

    try {
      const opts: DialOptions = {
        authEntity,
        credentials: creds,
        webrtcOptions: {
          disableTrickleICE: false,
          rtcConfig: this.webrtcOptions?.rtcConfig,
        },
      }

      // Save authEntity, creds
      this.savedAuthEntity = authEntity
      this.savedCreds = creds

      if (this.webrtcOptions?.enabled) {
        // This should not have to be checked but tsc can't tell the difference...
        if (opts.webrtcOptions) {
          opts.webrtcOptions.signalingAuthEntity = opts.authEntity
          opts.webrtcOptions.signalingCredentials = opts.credentials
        }

        const webRTCConn = await dialWebRTC(this.webrtcOptions.signalingAddress || this.serviceHost, this.webrtcOptions.host, opts)

        /*
         * Lint disabled because we know that we are the only code to
         * read and then write to 'peerConn', even after we have awaited/paused.
         */
        this.peerConn = webRTCConn.peerConnection // eslint-disable-line require-atomic-updates
        this.transportFactory = webRTCConn.transportFactory

        webRTCConn.peerConnection.ontrack = (event) => {
          const { kind } = event.track

          const eventStream = event.streams[0]
          if (!eventStream) {
            throw new Error('expected event stream to exist')
          }
          const streamName = eventStream.id
          const streamContainers = document.querySelectorAll(`[data-stream="${streamName}"]`)

          for (const streamContainer of streamContainers) {
            const mediaElement = document.createElement(kind) as HTMLAudioElement | HTMLVideoElement
            mediaElement.srcObject = eventStream
            mediaElement.autoplay = true
            if (mediaElement instanceof HTMLVideoElement) {
              mediaElement.playsInline = true
              mediaElement.controls = false
            } else {
              mediaElement.controls = true
            }

            const child = streamContainer.querySelector(kind)
            child?.remove()
            streamContainer.append(mediaElement)
          }

          const streamPreviewContainers = document.querySelectorAll(`[data-stream-preview="${streamName}"]`)
          for (const streamContainer of streamPreviewContainers) {
            const mediaElementPreview = document.createElement(kind) as HTMLAudioElement | HTMLVideoElement
            mediaElementPreview.srcObject = eventStream
            mediaElementPreview.autoplay = true
            if (mediaElementPreview instanceof HTMLVideoElement) {
              mediaElementPreview.playsInline = true
              mediaElementPreview.controls = false
            } else {
              mediaElementPreview.controls = true
            }
            const child = streamContainer.querySelector(kind)
            child?.remove()
            streamContainer.append(mediaElementPreview)
          }
        }
      } else {
        this.transportFactory = await dialDirect(this.serviceHost, opts)
      }
    } finally {
      this.connectResolve?.()
      this.connectResolve = undefined

      /*
       * Lint disabled because we know that we are the only code to
       * read and then write to 'connecting', even after we have awaited/paused.
       */
      this.connecting = undefined // eslint-disable-line require-atomic-updates
    }
  }
}
