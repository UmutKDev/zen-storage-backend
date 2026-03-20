import {
  Body,
  Controller,
  Delete,
  HttpException,
  HttpStatus,
  Post,
  UploadedFile,
  UseInterceptors,
  Headers,
  ParseFilePipe,
  MaxFileSizeValidator,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiBody,
  ApiConsumes,
  ApiTags,
  ApiHeader,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { CloudService } from './cloud.service';
import {
  CloudAbortMultipartUploadRequestModel,
  CloudCompleteMultipartUploadRequestModel,
  CloudCompleteMultipartUploadResponseModel,
  CloudCreateMultipartUploadRequestModel,
  CloudCreateMultipartUploadResponseModel,
  CloudGetMultipartPartUrlRequestModel,
  CloudGetMultipartPartUrlResponseModel,
  CloudGetMultipartPartUrlsBatchRequestModel,
  CloudGetMultipartPartUrlsBatchResponseModel,
  CloudUploadPartRequestModel,
  CloudUploadPartResponseModel,
  ConflictDetailsResponseModel,
} from './cloud.model';
import { ApiSuccessResponse } from '@common/decorators/response.decorator';
import { User } from '@common/decorators/user.decorator';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { SizeFormatter } from '@common/helpers/cast.helper';
import {
  FOLDER_SESSION_HEADER,
  CLOUD_UPLOAD_THROTTLE,
  CLOUD_UPLOAD_PART_THROTTLE,
} from './cloud.constants';
import { TEAM_ID_HEADER } from '@modules/team/guards/team-context.guard';
import { CheckPolicies } from '@modules/authentication/casl/check-policies.decorator';
import { CaslAction, CaslSubject } from '@common/enums';

@Controller('Cloud/Upload')
@ApiTags('Cloud / Upload')
@ApiCookieAuth()
@ApiHeader({
  name: TEAM_ID_HEADER,
  required: false,
  description:
    'Optional team ID. When provided, uploads target the team storage.',
})
@CheckPolicies((Ability) =>
  Ability.can(CaslAction.Upload, CaslSubject.CloudUpload),
)
export class CloudUploadController {
  constructor(private readonly cloudService: CloudService) {}

  @ApiOperation({
    summary: 'Create a multipart upload session',
    description: 'Creates an UploadId and starts a multipart upload flow.',
  })
  @Post('CreateMultipartUpload')
  @Throttle(CLOUD_UPLOAD_THROTTLE)
  @ApiHeader({
    name: FOLDER_SESSION_HEADER,
    required: false,
    description: 'Session token for encrypted folder access',
  })
  @ApiSuccessResponse(CloudCreateMultipartUploadResponseModel)
  @ApiResponse({
    status: 409,
    description: 'Conflict detected — file already exists at target key',
    type: ConflictDetailsResponseModel,
  })
  async UploadCreateMultipartUpload(
    @Body() model: CloudCreateMultipartUploadRequestModel,
    @User() user: UserContext,
    @Headers(FOLDER_SESSION_HEADER) sessionToken?: string,
  ): Promise<CloudCreateMultipartUploadResponseModel> {
    if (model.TotalSize) {
      const UserStorage = await this.cloudService.UserStorageUsage(user);
      const usedStorageInMB = SizeFormatter({
        From: UserStorage.UsedStorageInBytes,
        FromUnit: 'B',
        ToUnit: 'MB',
      });
      const maxStoragePerUserInMB = SizeFormatter({
        From: UserStorage.MaxStorageInBytes,
        FromUnit: 'B',
        ToUnit: 'MB',
      });
      const newTotalStorageInMB = SizeFormatter({
        From: model.TotalSize,
        FromUnit: 'B',
        ToUnit: 'MB',
      });

      if (model.TotalSize > UserStorage.MaxUploadSizeBytes) {
        throw new HttpException(
          `File size exceeds the maximum upload size of ${SizeFormatter({ From: UserStorage.MaxUploadSizeBytes, FromUnit: 'B', ToUnit: 'MB' })} MB.`,
          HttpStatus.BAD_REQUEST,
        );
      }

      if (usedStorageInMB + newTotalStorageInMB > maxStoragePerUserInMB) {
        throw new HttpException(
          'Storage limit exceeded. Please upgrade your subscription.',
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    return this.cloudService.UploadCreateMultipartUpload(
      model,
      user,
      sessionToken,
    );
  }

  @ApiOperation({
    summary: 'Get a multipart upload part URL',
    description:
      'Returns an expiring URL to upload a single part for the provided UploadId and PartNumber.',
  })
  @Post('GetMultipartPartUrl')
  @Throttle(CLOUD_UPLOAD_THROTTLE)
  @ApiHeader({
    name: FOLDER_SESSION_HEADER,
    required: false,
    description: 'Session token for encrypted folder access',
  })
  @ApiSuccessResponse(CloudGetMultipartPartUrlResponseModel)
  async UploadGetMultipartPartUrl(
    @Body() model: CloudGetMultipartPartUrlRequestModel,
    @User() user: UserContext,
    @Headers(FOLDER_SESSION_HEADER) sessionToken?: string,
  ): Promise<CloudGetMultipartPartUrlResponseModel> {
    return this.cloudService.UploadGetMultipartPartUrl(
      model,
      user,
      sessionToken,
    );
  }

  @ApiOperation({
    summary: 'Get multipart upload part URLs in batch',
    description:
      'Returns expiring URLs for multiple parts at once. Accepts either TotalParts or specific PartNumbers.',
  })
  @Post('GetMultipartPartUrls')
  @Throttle(CLOUD_UPLOAD_THROTTLE)
  @ApiHeader({
    name: FOLDER_SESSION_HEADER,
    required: false,
    description: 'Session token for encrypted folder access',
  })
  @ApiSuccessResponse(CloudGetMultipartPartUrlsBatchResponseModel)
  async UploadGetMultipartPartUrlsBatch(
    @Body() model: CloudGetMultipartPartUrlsBatchRequestModel,
    @User() user: UserContext,
    @Headers(FOLDER_SESSION_HEADER) sessionToken?: string,
  ): Promise<CloudGetMultipartPartUrlsBatchResponseModel> {
    return this.cloudService.UploadGetMultipartPartUrlsBatch(
      model,
      user,
      sessionToken,
    );
  }

  @ApiOperation({
    summary: 'Upload a multipart part',
    description:
      'Accepts a single file part for a multipart upload. The request must be multipart/form-data.',
  })
  @Post('UploadPart')
  @Throttle(CLOUD_UPLOAD_PART_THROTTLE)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    type: CloudUploadPartRequestModel,
  })
  @UseInterceptors(FileInterceptor('File'))
  @ApiHeader({
    name: FOLDER_SESSION_HEADER,
    required: false,
    description: 'Session token for encrypted folder access',
  })
  @ApiSuccessResponse(CloudUploadPartResponseModel)
  async UploadPart(
    @Body() model: CloudUploadPartRequestModel,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({
            maxSize: Number(
              process.env.CLOUD_UPLOAD_PART_MAX_BYTES ?? 10485760,
            ),
          }),
        ],
      }),
    )
    file: Express.Multer.File,
    @User() user: UserContext,
    @Headers('content-md5') contentMd5?: string,
    @Headers(FOLDER_SESSION_HEADER) sessionToken?: string,
  ): Promise<CloudUploadPartResponseModel> {
    return this.cloudService.UploadPart(
      model,
      file,
      user,
      sessionToken,
      contentMd5,
    );
  }

  @ApiOperation({
    summary: 'Complete multipart upload',
    description:
      'Completes a multipart upload by providing the list of parts and finalizes the object.',
  })
  @Post('CompleteMultipartUpload')
  @Throttle(CLOUD_UPLOAD_THROTTLE)
  @ApiHeader({
    name: FOLDER_SESSION_HEADER,
    required: false,
    description: 'Session token for encrypted folder access',
  })
  @ApiSuccessResponse(CloudCompleteMultipartUploadResponseModel)
  async UploadCompleteMultipartUpload(
    @Body() model: CloudCompleteMultipartUploadRequestModel,
    @User() user: UserContext,
    @Headers(FOLDER_SESSION_HEADER) sessionToken?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<CloudCompleteMultipartUploadResponseModel> {
    return this.cloudService.UploadCompleteMultipartUpload(
      model,
      user,
      sessionToken,
      idempotencyKey,
    );
  }

  @ApiOperation({
    summary: 'Abort a multipart upload',
    description:
      'Abort an ongoing multipart upload and clean up temporary state.',
  })
  @Delete('AbortMultipartUpload')
  @Throttle(CLOUD_UPLOAD_THROTTLE)
  async UploadAbortMultipartUpload(
    @Body() model: CloudAbortMultipartUploadRequestModel,
    @User() user: UserContext,
  ): Promise<void> {
    return this.cloudService.UploadAbortMultipartUpload(model, user);
  }
}
