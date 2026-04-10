import {
  Body,
  Controller,
  Delete,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { Public } from '@common/decorators/public.decorator';
import { User } from '@common/decorators/user.decorator';
import { ApiKeyScope } from '@common/enums/authentication.enum';
import { CloudService } from '@modules/cloud/cloud.service';
import {
  DirectoryCreateRequestModel,
  DirectoryDeleteRequestModel,
  DirectoryResponseModel,
} from '@modules/cloud/cloud.model';
import { ApiAuthGuard } from '../guards/api-auth.guard';
import { ApiScopeGuard } from '../guards/api-scope.guard';
import { ApiQuotaGuard } from '../guards/api-quota.guard';
import { ApiRateLimitGuard } from '../guards/api-rate-limit.guard';
import { ApiGeolocationInterceptor } from '../interceptors/api-geolocation.interceptor';
import { ApiIdempotencyInterceptor } from '../interceptors/api-idempotency.interceptor';
import { ApiUsageTrackingInterceptor } from '../interceptors/api-usage-tracking.interceptor';
import { ApiScopes } from '../decorators/api-scopes.decorator';
import { Idempotent } from '../decorators/api-idempotent.decorator';

@Controller({ path: 'Directory', version: '1' })
@ApiTags('API / Directory')
@Public()
@UseGuards(ApiAuthGuard, ApiScopeGuard, ApiQuotaGuard, ApiRateLimitGuard)
@UseInterceptors(
  ApiGeolocationInterceptor,
  ApiIdempotencyInterceptor,
  ApiUsageTrackingInterceptor,
)
@ApiHeader({ name: 'x-api-key', required: true })
@ApiHeader({ name: 'x-api-secret', required: true })
export class ApiDirectoryController {
  constructor(private readonly CloudService: CloudService) {}

  @Post()
  @ApiScopes(ApiKeyScope.WRITE)
  @Idempotent()
  async Create(
    @Body() model: DirectoryCreateRequestModel,
    @User() user: UserContext,
  ): Promise<DirectoryResponseModel> {
    return this.CloudService.DirectoryCreate(model, undefined, user);
  }

  @Delete()
  @ApiScopes(ApiKeyScope.DELETE)
  @Idempotent()
  async DeleteDirectory(
    @Body() model: DirectoryDeleteRequestModel,
    @User() user: UserContext,
  ): Promise<boolean> {
    return this.CloudService.DirectoryDelete(model, undefined, user);
  }
}
