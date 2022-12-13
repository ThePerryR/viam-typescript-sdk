import {
  createConnectTransport,
  createPromiseClient
} from '@bufbuild/connect-web'
import { CameraService } from '../../gen_es/component/camera/v1/camera_connectweb'
import type Client from '../../Client'
import { GetPointCloudRequest } from '../../gen_es/component/camera/v1/camera_pb'
import { MimeType } from './Camera'

export class CameraClientES {
  private client: Client
  private readonly name: string

  constructor (client: Client, name: string) {
    this.client = client
    this.name = name
  }

  async getPointCloud (): Promise<Uint8Array> {
    const request = new GetPointCloudRequest({
      mimeType: MimeType.PCD,
      name: this.name,
    })

    const transport = createConnectTransport({
      baseUrl: this.client.host,
    })
    const client = createPromiseClient(CameraService, transport)
    const response = await client.getPointCloud(request)
    return response.pointCloud
  }
}
