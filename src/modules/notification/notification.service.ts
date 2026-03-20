import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Server } from 'socket.io';
import dayjs from 'dayjs';
import { NotificationType } from '@common/enums';
import { NotificationPayloadModel } from './notification.model';
import {
  NotificationHistory,
  NotificationHistoryDocument,
} from '@schemas/notification-history.schema';

@Injectable()
export class NotificationService {
  private readonly Logger = new Logger(NotificationService.name);
  private Server: Server;

  constructor(
    @InjectModel(NotificationHistory.name)
    private readonly NotificationHistoryModel: Model<NotificationHistoryDocument>,
  ) {}

  /**
   * Called by NotificationGateway.afterInit() to inject the Socket.IO server instance.
   */
  SetServer(server: Server): void {
    this.Server = server;
  }

  /**
   * Emit a notification to a specific user by their room (`user:{UserId}`).
   */
  EmitToUser(
    UserId: string,
    Type: NotificationType,
    Title: string,
    Message: string,
    Data?: Record<string, unknown>,
  ): void {
    if (!this.Server) {
      this.Logger.warn('Socket.IO server not initialized — skipping emission');
      return;
    }

    const payload: NotificationPayloadModel = {
      Type,
      Title,
      Message,
      Data: Data ?? null,
      Timestamp: dayjs().utc().format(),
    };

    this.Server.to(`user:${UserId}`).emit('notification', payload);
    // this.Logger.debug(
    //   `Notification [${Type}] emitted to user:${UserId} — "${Title}"`,
    // );

    // Persist to MongoDB (fire-and-forget, never block the emitter)
    this.NotificationHistoryModel.create({
      UserId,
      Type,
      Title,
      Message,
      Data: Data ?? null,
      IsRead: false,
    }).catch((err) =>
      this.Logger.error(
        `Failed to persist notification to MongoDB: ${err.message}`,
        err.stack,
      ),
    );
  }

  /**
   * Emit a notification to multiple users.
   */
  EmitToUsers(
    UserIds: string[],
    Type: NotificationType,
    Title: string,
    Message: string,
    Data?: Record<string, unknown>,
  ): void {
    for (const UserId of UserIds) {
      this.EmitToUser(UserId, Type, Title, Message, Data);
    }
  }

  /**
   * Emit a notification to all connected clients (e.g., admin broadcast).
   */
  EmitToAll(
    Type: NotificationType,
    Title: string,
    Message: string,
    Data?: Record<string, unknown>,
  ): void {
    if (!this.Server) {
      this.Logger.warn('Socket.IO server not initialized — skipping emission');
      return;
    }

    const payload: NotificationPayloadModel = {
      Type,
      Title,
      Message,
      Data: Data ?? null,
      Timestamp: dayjs().utc().format(),
    };

    this.Server.emit('notification', payload);
    // this.Logger.debug(`Broadcast notification [${Type}] — "${Title}"`);
  }

  /**
   * Check if a user currently has active WebSocket connections.
   */
  async IsUserConnected(UserId: string): Promise<boolean> {
    if (!this.Server) return false;
    const sockets = await this.Server.in(`user:${UserId}`).fetchSockets();
    return sockets.length > 0;
  }

  /**
   * Get count of currently connected unique users.
   */
  async GetConnectedUserCount(): Promise<number> {
    if (!this.Server) return 0;
    const sockets = await this.Server.fetchSockets();
    const uniqueUsers = new Set(
      sockets.map((s) => s.data?.user?.Id).filter(Boolean),
    );
    return uniqueUsers.size;
  }

  /**
   * Get paginated notification history for a user.
   */
  async GetNotificationHistory(
    UserId: string,
    Skip: number,
    Take: number,
  ): Promise<{ Items: NotificationHistoryDocument[]; Count: number }> {
    const [Items, Count] = await Promise.all([
      this.NotificationHistoryModel.find({ UserId })
        .sort({ CreatedAt: -1 })
        .skip(Skip)
        .limit(Take)
        .lean()
        .exec(),
      this.NotificationHistoryModel.countDocuments({ UserId }),
    ]);

    return { Items: Items as NotificationHistoryDocument[], Count };
  }

  /**
   * Get unread notification count for a user.
   */
  async GetUnreadCount(UserId: string): Promise<number> {
    return this.NotificationHistoryModel.countDocuments({
      UserId,
      IsRead: false,
    });
  }

  /**
   * Mark a single notification as read.
   */
  async MarkAsRead(UserId: string, NotificationId: string): Promise<void> {
    await this.NotificationHistoryModel.updateOne(
      { _id: NotificationId, UserId },
      { $set: { IsRead: true, ReadAt: new Date() } },
    );
  }

  /**
   * Mark all notifications as read for a user.
   */
  async MarkAllAsRead(UserId: string): Promise<void> {
    await this.NotificationHistoryModel.updateMany(
      { UserId, IsRead: false },
      { $set: { IsRead: true, ReadAt: new Date() } },
    );
  }
}
