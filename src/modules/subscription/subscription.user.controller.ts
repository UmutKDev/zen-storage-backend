import { Body, Controller, Get, Post, Delete } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { SubscriptionService } from './subscription.service';
import {
  SubscribeRequestModel,
  UserSubscriptionResponseModel,
} from './subscription.model';
import { User } from '@common/decorators/user.decorator';
import { CheckPolicies } from '@modules/authentication/casl/check-policies.decorator';
import { CaslAction, CaslSubject } from '@common/enums';
import { ApiSuccessResponse } from '@common/decorators/response.decorator';

@Controller('Subscription')
@ApiTags('Subscription')
@ApiCookieAuth()
export class SubscriptionUserController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  @CheckPolicies((Ability) =>
    Ability.can(CaslAction.Read, CaslSubject.MySubscription),
  )
  @Get('My')
  @ApiSuccessResponse(UserSubscriptionResponseModel)
  async My(
    @User() user: UserContext,
  ): Promise<UserSubscriptionResponseModel | null> {
    return await this.subscriptionService.GetCurrentForUser({
      userId: user.Id,
    });
  }

  @CheckPolicies((Ability) =>
    Ability.can(CaslAction.Create, CaslSubject.MySubscription),
  )
  @Post('My/Subscribe')
  async Subscribe(
    @User() user: UserContext,
    @Body() model: SubscribeRequestModel,
  ): Promise<boolean> {
    return await this.subscriptionService.SubscribeSelf({
      userId: user.Id,
      subscriptionId: model.SubscriptionId,
      isTrial: model.IsTrial,
    });
  }

  @CheckPolicies((Ability) =>
    Ability.can(CaslAction.Delete, CaslSubject.MySubscription),
  )
  @Delete('My/Unsubscribe')
  async Unsubscribe(@User() user: UserContext): Promise<boolean> {
    return await this.subscriptionService.UnsubscribeByUser({
      userId: user.Id,
    });
  }
}
