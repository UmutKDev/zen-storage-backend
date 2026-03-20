import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { SessionService } from '@modules/authentication/session/session.service';
import { NotificationService } from './notification.service';

/**
 * Parse a raw Cookie header string into a key-value map.
 */
function parseCookies(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of raw.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = decodeURIComponent(pair.slice(idx + 1).trim());
    result[key] = value;
  }
  return result;
}

const corsOrigins =
  process.env.NODE_ENV === 'development'
    ? ['*', 'http://localhost:3001']
    : ['https://api.storage.umutk.me', 'https://storage.umutk.me'];

@WebSocketGateway({
  namespace: '/notifications',
  cors: {
    origin: corsOrigins,
    credentials: true,
  },
})
export class NotificationGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly Logger = new Logger(NotificationGateway.name);

  @WebSocketServer()
  Server: Server;

  constructor(
    private readonly SessionService: SessionService,
    private readonly NotificationService: NotificationService,
  ) {}

  afterInit(server: Server): void {
    this.NotificationService.SetServer(server);
    this.Logger.log('Notification WebSocket Gateway initialized');
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const sessionId = this.ExtractSessionId(client);

      if (!sessionId) {
        this.Logger.warn(`Connection rejected — no session ID (${client.id})`);
        client.disconnect();
        return;
      }

      const session = await this.SessionService.getSession(sessionId);

      if (!session) {
        client.disconnect();
        return;
      }

      // Attach user context to socket
      const userContext: UserContext = {
        Id: session.UserId,
        Email: session.Email,
        FullName: session.FullName,
        Role: session.Role,
        Status: session.Status,
        Image: session.Image,
      };

      client.data.user = userContext;
      await client.join(`user:${session.UserId}`);
    } catch (error) {
      this.Logger.error(
        `Connection error for socket ${client.id}: ${error.message}`,
      );
      client.disconnect();
    }
  }

  handleDisconnect() // client: Socket
  : void {
    // const user = client.data?.user as UserContext;
    // if (user) {
    //   this.Logger.log(
    //     `User disconnected: ${user.FullName} (${user.Id}) — socket ${client.id}`,
    //   );
    // }
  }

  @SubscribeMessage('ping')
  HandlePing(
    @ConnectedSocket() client: Socket,
    @MessageBody() _data: unknown,
  ): { event: string; data: { Timestamp: string } } {
    void _data;
    return {
      event: 'pong',
      data: { Timestamp: new Date().toISOString() },
    };
  }

  /**
   * Extract session ID from WebSocket handshake.
   * Priority: socket.io auth > cookie > custom header > bearer > query param
   */
  private ExtractSessionId(client: Socket): string | null {
    // 1. Socket.IO auth payload — io(url, { auth: { SessionId } })
    const authPayload = client.handshake?.auth;
    if (authPayload?.SessionId && typeof authPayload.SessionId === 'string') {
      return authPayload.SessionId;
    }

    // 2. Cookie
    const rawCookies = client.handshake?.headers?.cookie;
    if (rawCookies) {
      const parsed = parseCookies(rawCookies);
      if (parsed['session_id']) {
        return parsed['session_id'];
      }
    }

    // 3. Custom header
    const headerSession = client.handshake?.headers?.['x-session-id'];
    if (headerSession && typeof headerSession === 'string') {
      return headerSession;
    }

    // 4. Authorization Bearer
    const authHeader = client.handshake?.headers?.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }

    // 5. Query parameter
    const querySession = client.handshake?.query?.session_id;
    if (querySession && typeof querySession === 'string') {
      return querySession;
    }

    return null;
  }
}
