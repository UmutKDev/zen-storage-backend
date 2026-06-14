import { ApiProperty, OmitType } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsPositive,
  IsUUID,
} from 'class-validator';
import { BaseDateModel } from '@common/models/base.model';
import { BillingCycle, SubscriptionStatus } from '@common/enums';

export class SubscriptionDateModel extends BaseDateModel {}

export class SubscriptionViewModel {
  @Expose()
  @ApiProperty({ format: 'uuid' })
  Id: string;

  @Expose()
  @ApiProperty()
  @IsString()
  Name: string;

  @Expose()
  @ApiProperty()
  @IsString()
  Slug: string;

  @Expose()
  @ApiProperty({ required: false })
  @IsOptional()
  Description?: string;

  @Expose()
  @ApiProperty({ description: 'Price in cents' })
  @IsInt()
  @IsPositive()
  Price: number;

  @Expose()
  @ApiProperty({ default: 'USD' })
  @IsString()
  Currency: string;

  @Expose()
  @ApiProperty({ enum: BillingCycle })
  BillingCycle: string;

  @Expose()
  @ApiProperty({ description: 'Storage limit in bytes - 0 means unlimited' })
  @IsInt()
  StorageLimitBytes: number;

  @Expose()
  @ApiProperty({ required: false })
  @IsOptional()
  MaxObjectCount?: number | null;

  @Expose()
  @ApiProperty({ required: false })
  @IsOptional()
  Features?: Record<string, unknown> | null;

  @Expose()
  @ApiProperty({ enum: SubscriptionStatus })
  Status: string;

  @Expose()
  @ApiProperty({ type: SubscriptionDateModel })
  Date: SubscriptionDateModel;
}

export class SubscriptionResponseModel extends OmitType(SubscriptionViewModel, [
  'Price',
] as const) {}

export class SubscriptionListResponseModel extends SubscriptionResponseModel {}

export class SubscriptionFindResponseModel extends SubscriptionResponseModel {}

export class SubscriptionBodyRequestModel extends OmitType(
  SubscriptionViewModel,
  ['Id', 'Date'] as const,
) {}

export class SubscriptionPostBodyRequestModel extends SubscriptionBodyRequestModel {}

export class SubscriptionPutBodyRequestModel extends OmitType(
  SubscriptionBodyRequestModel,
  ['Slug'] as const,
) {}

/* -------------------------------------------- */
/* User subscription DTOs                        */
/* -------------------------------------------- */

export class UserSubscriptionViewModel {
  @Expose()
  @ApiProperty({ format: 'uuid' })
  Id: string;

  @Expose()
  @ApiProperty()
  StartAt: Date;

  @Expose()
  @ApiProperty({ required: false })
  EndAt?: Date | null;

  @Expose()
  @ApiProperty()
  IsTrial: boolean;

  @Expose()
  @ApiProperty({ description: 'Price as cents' })
  Price: number;

  @Expose()
  @ApiProperty({ required: false })
  Currency?: string;

  @Expose()
  @ApiProperty({ required: false, type: SubscriptionResponseModel })
  @Type(() => SubscriptionResponseModel)
  Subscription?: SubscriptionResponseModel;

  @Expose()
  @ApiProperty({ type: BaseDateModel })
  @Type(() => BaseDateModel)
  Date: BaseDateModel;
}

export class UserSubscriptionResponseModel extends OmitType(
  UserSubscriptionViewModel,
  [] as const,
) {}

export class SubscribeRequestModel {
  @ApiProperty({ format: 'uuid' })
  @IsNotEmpty()
  @IsUUID()
  SubscriptionId: string;

  @ApiProperty({ required: false })
  IsTrial?: boolean;

  @ApiProperty({ required: false })
  ProviderSubscriptionId?: string;
}

export class SubscribeAsAdminRequestModel extends SubscribeRequestModel {
  @ApiProperty({ format: 'uuid' })
  UserId: string;
}

export class UnsubscribeRequestModel {
  @ApiProperty({ format: 'uuid' })
  Id: string;
}
