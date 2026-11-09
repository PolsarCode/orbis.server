import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { PresenceGateway } from '../friends/presence.gateway';
import { MessagesService } from './messages.service';

@WebSocketGateway({ cors: true })
export class MessagesGateway {
  constructor(
    private messages: MessagesService,
    private presence: PresenceGateway,
  ) {}

  @SubscribeMessage('typing')
  async typing(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId?: unknown; typing?: unknown } | null,
  ) {
    const userId: number | undefined = client.data.userId;
    const conversationId = body?.conversationId;
    if (userId === undefined || !Number.isInteger(conversationId)) return;

    if (body?.typing === true) {
      void this.presence.markActive(client).catch(() => null);
    }
    await this.messages
      .typing(userId, conversationId as number, body?.typing === true)
      .catch(() => null);
  }
}
