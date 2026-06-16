import { CacheModule } from '@nestjs/cache-manager';
import { Module, Global, Logger } from '@nestjs/common';
import KeyvRedis from '@keyv/redis';
import { RedisService } from './redis.service';

const IS_DEVELOPMENT = process.env.NODE_ENV === 'development';
const REDIS_ENABLED =
  (process.env.REDIS_ENABLED ?? 'true').toLowerCase() !== 'false';

const buildRedisUrl = (): string => {
  // Environment-isolated cache DB: production → 0, test/dev → 1, so the live and
  // test caches on a shared Redis instance never mix. (BullMQ stays on DB 0 via
  // BuildBullRedisConnectionOptions — intentionally untouched.)
  const database = process.env.NODE_ENV === 'production' ? 0 : 1;
  const host = process.env.REDIS_HOSTNAME ?? 'localhost';
  const port = process.env.REDIS_PORT ?? '6379';
  const password = process.env.REDIS_PASSWORD;
  return password
    ? `redis://:${encodeURIComponent(password)}@${host}:${port}/${database}`
    : `redis://${host}:${port}/${database}`;
};

@Global()
@Module({
  imports: [
    // If REDIS is enabled, register Redis store; otherwise register default in-memory cache
    REDIS_ENABLED
      ? CacheModule.registerAsync({
          isGlobal: true,
          useFactory: async () => {
            const logger = new Logger('RedisModule');
            logger.log(
              'Using Redis store - sessions will persist across restarts',
            );
            return {
              stores: [new KeyvRedis(buildRedisUrl())],
              ttl: parseInt(process.env.REDIS_TTL, 10) * 1000, // default TTL in ms
            };
          },
        })
      : CacheModule.register({
          isGlobal: true,
          ttl: parseInt(process.env.REDIS_TTL, 10) * 1000, // default TTL in ms
        }),
  ],
  providers: [RedisService],
  exports: [RedisService, CacheModule],
})
export class RedisModule {
  private readonly logger = new Logger(RedisModule.name);

  constructor() {
    if (!REDIS_ENABLED && IS_DEVELOPMENT) {
      this.logger.warn(
        '⚠️  In-memory cache is being used. Sessions will be lost on restart!',
      );
      this.logger.warn(
        '   To persist sessions in development, set REDIS_ENABLED=true and configure Redis.',
      );
    }
  }
}
