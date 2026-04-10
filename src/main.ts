import './instrument';
import { NestFactory, Reflector } from '@nestjs/core';
import { CoreModule } from './modules/core/core.module';
import {
  ClassSerializerInterceptor,
  RequestMethod,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { TransformInterceptor } from '@common/interceptors/transform.interceptor';
import { RequestContextMiddleware } from './common/context/context.middleware';
import { apiReference } from '@scalar/nestjs-api-reference';
import { json, urlencoded } from 'express';
import { NestExpressApplication } from '@nestjs/platform-express';
import { useContainer } from 'class-validator';
import basicAuth from 'express-basic-auth';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);

const corsOrigins =
  process.env.NODE_ENV === 'development'
    ? (process.env.CORS_ORIGINS_DEV?.split(',') ?? [
        'http://localhost:3000',
        'http://localhost:4000',
      ])
    : ['https://api.storage.umutk.me', 'https://storage.umutk.me'];

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(CoreModule, {
    cors: {
      origin: corsOrigins,
      credentials: true,
    },
    logger: ['error', 'warn', 'log', 'fatal', 'debug'],
  });
  app.set('query parser', 'extended');

  app.enableVersioning({ type: VersioningType.URI });

  app.use(helmet());

  const payloadLimit = process.env.PAYLOAD_LIMIT ?? '10mb';
  app.use(json({ limit: payloadLimit }));
  app.use(urlencoded({ extended: true, limit: payloadLimit }));
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      skipMissingProperties: false,
      transformOptions: {
        enableImplicitConversion: true,
        exposeDefaultValues: true,
      },
    }),
  );

  app.setGlobalPrefix('/Api', {
    exclude: [
      { path: '/', method: RequestMethod.GET },
      { path: '/health', method: RequestMethod.GET },
    ],
  });

  app.use(RequestContextMiddleware);

  app.useGlobalInterceptors(
    new TransformInterceptor(),
    new ClassSerializerInterceptor(app.get(Reflector), {
      excludeExtraneousValues: true,
      exposeDefaultValues: true,
    }),
  );

  useContainer(app.select(CoreModule), { fallbackOnErrors: true });

  if (process.env.NODE_ENV === 'production') {
    app.use(
      ['/swagger', '/swagger-json', '/reference'],
      basicAuth({
        challenge: true,
        users: { [process.env.SWAGGER_USER]: process.env.SWAGGER_PASSWORD },
      }),
    );
  }

  const document = SwaggerModule.createDocument(app, SwaggerConfig, {
    operationIdFactory: (_, methodKey) => methodKey,
  });
  SwaggerModule.setup('swagger', app, document);

  app.use('/reference', apiReference({ content: document }));

  await app.listen(process.env.PORT || 8080);
}

const SwaggerConfig = new DocumentBuilder()
  .setTitle('Base API Service')

  .setDescription('Base API Service Test Environment & Documentation')
  .setVersion('1.0')

  .addTag('Home')
  .addTag('Health')
  .addTag('Authentication')
  .addTag('Account')
  .addTag('Account / Security')
  .addTag('User')
  .addTag('Definition')
  .addTag('Cloud')
  .addTag('Cloud / Upload')
  .addTag('Cloud / Directory')
  .addTag('Cloud / Archive')
  .addTag('Cloud / Documents')
  .addTag('Team')
  .addTag('Team / Members')
  .addTag('Team / Invitations')
  .addTag('Notification')
  .addTag('API / Storage')
  .addTag('API / Upload')
  .addTag('API / Download')
  .addTag('API / Directory')
  .addTag('API / Webhooks')
  .addTag('API / Usage')
  .addCookieAuth('session_id')
  .addApiKey(
    {
      type: 'apiKey',
      name: 'x-api-key',
      in: 'header',
      description: 'API Public Key',
    },
    'api-key',
  )
  .addApiKey(
    {
      type: 'apiKey',
      name: 'x-api-secret',
      in: 'header',
      description: 'API Secret Key',
    },
    'api-secret',
  )
  .build();

bootstrap();
