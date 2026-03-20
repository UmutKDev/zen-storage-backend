import { Global, Module, Logger } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ApiUsageLog, ApiUsageLogSchema } from '@schemas/api-usage-log.schema';
import {
  NotificationHistory,
  NotificationHistorySchema,
} from '@schemas/notification-history.schema';
import { AuditLog, AuditLogSchema } from '@schemas/audit-log.schema';
import { AuditLogService } from './audit-log.service';

const MONGO_ENABLED =
  (process.env.MONGO_ENABLED ?? 'true').toLowerCase() !== 'false';

const featureModules = MONGO_ENABLED
  ? [
      MongooseModule.forFeature([
        { name: ApiUsageLog.name, schema: ApiUsageLogSchema },
        { name: NotificationHistory.name, schema: NotificationHistorySchema },
        { name: AuditLog.name, schema: AuditLogSchema },
      ]),
    ]
  : [];

const URI = MONGO_ENABLED
  ? `mongodb://${process.env.MONGO_USERNAME}:${encodeURIComponent(
      process.env.MONGO_PASSWORD,
    )}@${process.env.MONGO_HOSTNAME}:${process.env.MONGO_PORT}`
  : null;
@Global()
@Module({
  imports: [
    ...(MONGO_ENABLED
      ? [
          MongooseModule.forRoot(URI, {
            dbName: process.env.MONGO_DATABASE,
            maxPoolSize: 10,
            minPoolSize: 2,
            connectTimeoutMS: 10000,
            socketTimeoutMS: 45000,
          }),
        ]
      : []),
    ...featureModules,
  ],
  providers: MONGO_ENABLED ? [AuditLogService] : [],
  exports: MONGO_ENABLED ? [MongooseModule, AuditLogService] : [],
})
export class MongoModule {
  private readonly Logger = new Logger(MongoModule.name);

  constructor() {
    if (MONGO_ENABLED) {
      this.Logger.log('MongoDB connection initialized');
    } else {
      this.Logger.warn(
        'MongoDB is disabled (MONGO_ENABLED=false). Logging to MongoDB will be skipped.',
      );
    }
  }
}
