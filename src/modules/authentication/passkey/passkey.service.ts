import { Injectable, HttpException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PasskeyEntity } from '@entities/passkey.entity';
import { UserEntity } from '@entities/user.entity';
import { RedisService } from '@modules/redis/redis.service';
import {
  PASSKEY_CHALLENGE_TTL,
  HAS_PASSKEY_CACHE_TTL,
} from '@modules/redis/redis.ttl';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  VerifiedRegistrationResponse,
  VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/types';
import {
  PasskeyLoginBeginRequestModel,
  PasskeyLoginFinishRequestModel,
  PasskeyLoginBeginResponseModel,
} from '../authentication.model';
import {
  PasskeyRegistrationBeginRequestModel,
  PasskeyRegistrationFinishRequestModel,
  PasskeyRegistrationBeginResponseModel,
  PasskeyViewModel,
} from '../../account/security/security.model';
import { plainToInstance } from 'class-transformer';
import { AuthKeys } from '@modules/redis/redis.keys';

@Injectable()
export class PasskeyService {
  private readonly logger = new Logger(PasskeyService.name);
  private readonly RP_NAME = process.env.APP_NAME || 'Storage';
  private readonly RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
  private readonly ORIGIN = process.env.CLIENT_APP_URL;
  private readonly CHALLENGE_PREFIX = 'passkey:challenge';

  constructor(
    @InjectRepository(PasskeyEntity)
    private readonly passkeyRepository: Repository<PasskeyEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly redisService: RedisService,
  ) {}

  private getChallengeKey(
    userId: string,
    type: 'registration' | 'login',
  ): string {
    return `${this.CHALLENGE_PREFIX}:${type}:${userId}`;
  }

  async beginRegistration({
    User,
    DeviceName,
  }: {
    User: UserContext;
  } & PasskeyRegistrationBeginRequestModel): Promise<PasskeyRegistrationBeginResponseModel> {
    // Get existing passkeys for this user
    const existingPasskeys = await this.passkeyRepository.find({
      where: { User: { Id: User.Id } },
    });

    const excludeCredentials = existingPasskeys.map((passkey) => ({
      id: passkey.CredentialId,
      transports: passkey.Transports
        ? (JSON.parse(passkey.Transports) as AuthenticatorTransportFuture[])
        : undefined,
    }));

    const userIdBuffer = new TextEncoder().encode(User.Id);

    const options = await generateRegistrationOptions({
      rpName: this.RP_NAME,
      rpID: this.RP_ID,
      userID: userIdBuffer,
      userName: User.Email,
      userDisplayName: User.FullName || User.Email,
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
        authenticatorAttachment: 'platform',
      },
    });

    // Store challenge in Redis
    await this.redisService.Set(
      this.getChallengeKey(User.Id, 'registration'),
      { challenge: options.challenge, deviceName: DeviceName },
      PASSKEY_CHALLENGE_TTL,
    );

    return plainToInstance(PasskeyRegistrationBeginResponseModel, {
      Challenge: options.challenge,
      Options: options,
    });
  }

  async finishRegistration({
    User,
    DeviceName,
    Credential,
  }: {
    User: UserContext;
  } & PasskeyRegistrationFinishRequestModel): Promise<PasskeyViewModel> {
    // Get stored challenge
    const stored = await this.redisService.Get<{
      challenge: string;
      deviceName: string;
    }>(this.getChallengeKey(User.Id, 'registration'));

    if (!stored) {
      throw new HttpException('Registration challenge expired', 400);
    }

    let verification: VerifiedRegistrationResponse;
    try {
      verification = await verifyRegistrationResponse({
        response: Credential as unknown as RegistrationResponseJSON,
        expectedChallenge: stored.challenge,
        expectedOrigin: this.ORIGIN,
        expectedRPID: this.RP_ID,
      });
    } catch (error) {
      this.logger.error('Passkey registration verification failed', error?.stack);
      throw new HttpException('Verification failed', 400);
    }

    if (!verification.verified || !verification.registrationInfo) {
      throw new HttpException('Registration verification failed', 400);
    }

    const { credential: regCredential, credentialDeviceType } =
      verification.registrationInfo;

    // Save passkey
    const passkey = new PasskeyEntity({
      User: { Id: User.Id } as UserEntity,
      CredentialId: regCredential.id,
      PublicKey: Buffer.from(regCredential.publicKey).toString('base64'),
      Counter: Number(regCredential.counter),
      DeviceName: DeviceName || stored.deviceName,
      DeviceType: credentialDeviceType,
      Transports: (Credential as unknown as RegistrationResponseJSON).response
        .transports
        ? JSON.stringify(
            (Credential as unknown as RegistrationResponseJSON).response
              .transports,
          )
        : null,
    });

    const saved = await this.passkeyRepository.save(passkey);

    // Clear challenge
    await this.redisService.Delete(
      this.getChallengeKey(User.Id, 'registration'),
    );

    // Invalidate hasPasskey cache
    await this.redisService.Delete(AuthKeys.HasPasskey(User.Id));

    return plainToInstance(PasskeyViewModel, {
      Id: saved.Id,
      DeviceName: saved.DeviceName,
      DeviceType: saved.DeviceType,
      CreatedAt: saved.CreatedAt,
      LastUsedAt: saved.LastUsedAt,
    });
  }

  async beginLogin({
    Email,
  }: PasskeyLoginBeginRequestModel): Promise<PasskeyLoginBeginResponseModel> {
    const user = await this.userRepository.findOne({ where: { Email } });
    if (!user) {
      throw new HttpException('User not found', 404);
    }

    const passkeys = await this.passkeyRepository.find({
      where: { User: { Id: user.Id } },
    });

    if (passkeys.length === 0) {
      throw new HttpException('No passkeys registered', 400);
    }

    const options = await generateAuthenticationOptions({
      rpID: this.RP_ID,
      userVerification: 'required',
    });

    // Store challenge
    await this.redisService.Set(
      this.getChallengeKey(user.Id, 'login'),
      { challenge: options.challenge, userId: user.Id },
      PASSKEY_CHALLENGE_TTL,
    );

    return plainToInstance(PasskeyLoginBeginResponseModel, {
      Challenge: options.challenge,
      Options: options,
    });
  }

  async finishLogin({
    Email,
    Credential,
  }: PasskeyLoginFinishRequestModel): Promise<UserEntity> {
    const user = await this.userRepository.findOne({ where: { Email } });
    if (!user) {
      throw new HttpException('User not found', 404);
    }

    // Get stored challenge
    const stored = await this.redisService.Get<{
      challenge: string;
      userId: string;
    }>(this.getChallengeKey(user.Id, 'login'));

    if (!stored) {
      throw new HttpException('Login challenge expired', 400);
    }

    // Find the passkey
    const passkey = await this.passkeyRepository.findOne({
      where: {
        User: { Id: user.Id },
        CredentialId: (Credential as unknown as AuthenticationResponseJSON).id,
      },
    });

    if (!passkey) {
      throw new HttpException('Passkey not found', 400);
    }

    let verification: VerifiedAuthenticationResponse;
    try {
      verification = await verifyAuthenticationResponse({
        response: Credential as unknown as AuthenticationResponseJSON,
        expectedChallenge: stored.challenge,
        expectedOrigin: this.ORIGIN,
        expectedRPID: this.RP_ID,
        credential: {
          id: passkey.CredentialId,
          publicKey: Buffer.from(passkey.PublicKey, 'base64'),
          counter: Number(passkey.Counter),
          transports: passkey.Transports
            ? JSON.parse(passkey.Transports)
            : undefined,
        },
      });
    } catch (error) {
      this.logger.error('Passkey authentication verification failed', error?.stack);
      throw new HttpException('Authentication failed', 400);
    }

    if (!verification.verified) {
      throw new HttpException('Authentication verification failed', 400);
    }

    // Update counter and last used
    await this.passkeyRepository.update(
      { Id: passkey.Id },
      {
        Counter: verification.authenticationInfo.newCounter,
        LastUsedAt: new Date(),
      },
    );

    // Clear challenge
    await this.redisService.Delete(this.getChallengeKey(user.Id, 'login'));

    return user;
  }

  async getUserPasskeys(User: UserContext): Promise<PasskeyViewModel[]> {
    const passkeys = await this.passkeyRepository.find({
      where: { User: { Id: User.Id } },
      order: { CreatedAt: 'DESC' },
    });

    return passkeys.map((passkey) =>
      plainToInstance(PasskeyViewModel, {
        Id: passkey.Id,
        DeviceName: passkey.DeviceName,
        DeviceType: passkey.DeviceType,
        CreatedAt: passkey.CreatedAt,
        LastUsedAt: passkey.LastUsedAt,
      }),
    );
  }

  async deletePasskey(User: UserContext, passkeyId: string): Promise<boolean> {
    const result = await this.passkeyRepository.delete({
      Id: passkeyId,
      User: { Id: User.Id },
    });

    // Invalidate hasPasskey cache
    await this.redisService.Delete(AuthKeys.HasPasskey(User.Id));

    return result.affected > 0;
  }

  async hasPasskey(userId: string): Promise<boolean> {
    const cacheKey = AuthKeys.HasPasskey(userId);
    const cached = await this.redisService.Get<boolean>(cacheKey);
    if (cached !== undefined && cached !== null) return cached;

    const count = await this.passkeyRepository.count({
      where: { User: { Id: userId } },
    });
    const result = count > 0;
    await this.redisService.Set(cacheKey, result, HAS_PASSKEY_CACHE_TTL);
    return result;
  }
}
