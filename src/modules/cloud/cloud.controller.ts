import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Put,
  Query,
  Res,
  Headers,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiTags,
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';
import { CloudService } from './cloud.service';
import {
  CloudKeyRequestModel,
  CloudUpdateRequestModel,
  CloudListRequestModel,
  CloudListResponseModel,
  CloudDeleteRequestModel,
  CloudMoveRequestModel,
  CloudBreadCrumbModel,
  CloudDirectoryModel,
  CloudObjectModel,
  CloudListBreadcrumbRequestModel,
  CloudListDirectoriesRequestModel,
  CloudListObjectsRequestModel,
  CloudUserStorageUsageResponseModel,
  CloudScanStatusResponseModel,
  CloudPreSignedUrlRequestModel,
  CloudSearchRequestModel,
  CloudSearchResponseModel,
  ConflictDetailsResponseModel,
  CloudVersionListResponseModel,
  CloudRestoreVersionRequestModel,
  CloudDeleteVersionRequestModel,
} from './cloud.model';
import {
  ApiSuccessArrayResponse,
  ApiSuccessResponse,
} from '@common/decorators/response.decorator';
import { User } from '@common/decorators/user.decorator';
import { ThrottleTransform } from '@common/helpers/throttle.transform';
import { Throttle } from '@nestjs/throttler';
import { pipeline } from 'stream';
import { promisify } from 'util';
import type { Response } from 'express';
import {
  FOLDER_SESSION_HEADER,
  HIDDEN_SESSION_HEADER,
  CLOUD_DOWNLOAD_THROTTLE,
} from './cloud.constants';
import { TEAM_ID_HEADER } from '@modules/team/guards/team-context.guard';
import { CheckPolicies } from '@modules/authentication/casl/check-policies.decorator';
import { CaslAction, CaslSubject } from '@common/enums';

@Controller('Cloud')
@ApiTags('Cloud')
@ApiCookieAuth()
@ApiHeader({
  name: TEAM_ID_HEADER,
  required: false,
  description:
    'Optional team ID. When provided, all cloud operations target the team storage instead of personal storage.',
})
@CheckPolicies((Ability) => Ability.can(CaslAction.Read, CaslSubject.Cloud))
export class CloudController {
  constructor(private readonly cloudService: CloudService) {}

  @ApiOperation({
    summary: 'List files and directories',
    description:
      'Returns a view (breadcrumbs, directories and objects) for the given user-scoped path. Supports delimiter and metadata processing flags. For encrypted folders, provide session token via X-Folder-Session header.',
  })
  @Get('List')
  @ApiHeader({
    name: FOLDER_SESSION_HEADER,
    required: false,
    description: 'Session token for encrypted folder access',
  })
  @ApiHeader({
    name: HIDDEN_SESSION_HEADER,
    required: false,
    description: 'Session token for hidden folder access',
  })
  @ApiSuccessResponse(CloudListResponseModel)
  async List(
    @Query() model: CloudListRequestModel,
    @User() user: UserContext,
    @Headers(FOLDER_SESSION_HEADER) sessionToken?: string,
    @Headers(HIDDEN_SESSION_HEADER) hiddenSessionToken?: string,
  ): Promise<CloudListResponseModel> {
    return this.cloudService.List(
      model,
      user,
      sessionToken,
      hiddenSessionToken,
    );
  }

  @ApiOperation({
    summary: 'Get breadcrumb for a path',
    description:
      'Returns breadcrumb entries (path pieces) for the supplied path.',
  })
  @Get('List/Breadcrumb')
  @ApiSuccessArrayResponse(CloudBreadCrumbModel)
  async ListBreadcrumb(
    @Query() model: CloudListBreadcrumbRequestModel,
  ): Promise<CloudBreadCrumbModel[]> {
    return this.cloudService.ListBreadcrumb(model);
  }

  @ApiOperation({
    summary: 'List directories inside a path',
    description:
      'Returns directory prefixes (folders) for a given path. For encrypted folders, provide session token via X-Folder-Session header.',
  })
  @Get('List/Directories')
  @ApiHeader({
    name: FOLDER_SESSION_HEADER,
    required: false,
    description: 'Session token for encrypted folder access',
  })
  @ApiHeader({
    name: HIDDEN_SESSION_HEADER,
    required: false,
    description: 'Session token for hidden folder access',
  })
  @ApiSuccessArrayResponse(CloudDirectoryModel)
  async ListDirectories(
    @Query() model: CloudListDirectoriesRequestModel,
    @User() user: UserContext,
    @Headers(FOLDER_SESSION_HEADER) sessionToken?: string,
    @Headers(HIDDEN_SESSION_HEADER) hiddenSessionToken?: string,
  ): Promise<CloudDirectoryModel[]> {
    return this.cloudService.ListDirectories(
      model,
      user,
      sessionToken,
      hiddenSessionToken,
    );
  }

  @ApiOperation({
    summary: 'List objects (files) inside a path',
    description:
      'Returns files at a given path for the authenticated user. For encrypted folders, provide session token via X-Folder-Session header.',
  })
  @Get('List/Objects')
  @ApiHeader({
    name: FOLDER_SESSION_HEADER,
    required: false,
    description: 'Session token for encrypted folder access',
  })
  @ApiSuccessArrayResponse(CloudObjectModel)
  async ListObjects(
    @Query() model: CloudListObjectsRequestModel,
    @User() user: UserContext,
    @Headers(FOLDER_SESSION_HEADER) sessionToken?: string,
  ): Promise<CloudObjectModel[]> {
    return this.cloudService.ListObjects(model, user, sessionToken);
  }

  @ApiOperation({
    summary: 'Search files by name',
    description:
      "Recursively searches the user's files by partial filename match (case-insensitive). " +
      'Optionally restrict to a specific path or filter by extension. ' +
      'Encrypted folder contents are excluded unless a valid session token is provided via X-Folder-Session header.',
  })
  @Get('Search')
  @ApiHeader({
    name: FOLDER_SESSION_HEADER,
    required: false,
    description: 'Session token for encrypted folder access',
  })
  @ApiHeader({
    name: HIDDEN_SESSION_HEADER,
    required: false,
    description: 'Session token for hidden folder access',
  })
  @ApiSuccessResponse(CloudSearchResponseModel)
  async Search(
    @Query() model: CloudSearchRequestModel,
    @User() user: UserContext,
    @Headers(FOLDER_SESSION_HEADER) sessionToken?: string,
    @Headers(HIDDEN_SESSION_HEADER) hiddenSessionToken?: string,
  ): Promise<CloudSearchResponseModel> {
    return this.cloudService.Search(
      model,
      user,
      sessionToken,
      hiddenSessionToken,
    );
  }

  @ApiOperation({
    summary: "Get user's storage usage",
    description: 'Returns the authenticated user storage usage and limits.',
  })
  @Get('User/StorageUsage')
  @ApiSuccessResponse(CloudUserStorageUsageResponseModel)
  async UserStorageUsage(
    @User() user: UserContext,
  ): Promise<CloudUserStorageUsageResponseModel> {
    return this.cloudService.UserStorageUsage(user);
  }

  @ApiOperation({
    summary: 'Get antivirus scan status for a file',
    description:
      'Returns the latest antivirus scan status for the given object key.',
  })
  @Get('Scan/Status')
  @ApiSuccessResponse(CloudScanStatusResponseModel)
  async ScanStatus(
    @Query() model: CloudKeyRequestModel,
    @User() user: UserContext,
  ): Promise<CloudScanStatusResponseModel | null> {
    return this.cloudService.GetScanStatus(model, user);
  }

  @ApiOperation({
    summary: 'Get object metadata',
    description:
      'Find a single object by key (user scoped) and return its metadata.',
  })
  @Get('Find')
  async Find(@Query() model: CloudKeyRequestModel, @User() user: UserContext) {
    return this.cloudService.Find(model, user);
  }

  @ApiOperation({
    summary: 'Get a presigned URL for upload/download',
    description:
      'Returns a presigned URL for a specific object key to allow direct client access.',
  })
  @ApiSuccessResponse('string')
  @Get('PresignedUrl')
  async GetPresignedUrl(
    @Query() model: CloudPreSignedUrlRequestModel,
    @User() user: UserContext,
  ) {
    return this.cloudService.GetPresignedUrl(model, user);
  }

  @CheckPolicies((Ability) => Ability.can(CaslAction.Update, CaslSubject.Cloud))
  @ApiOperation({
    summary: 'Move/rename an object',
    description:
      'Move an object from SourceKey to DestinationKey within the user scope.',
  })
  @ApiResponse({
    status: 200,
    description: 'Move succeeded',
    schema: { type: 'boolean' },
  })
  @ApiResponse({
    status: 409,
    description: 'Conflict detected — target already exists',
    type: ConflictDetailsResponseModel,
  })
  @Put('Move')
  async Move(
    @Body() model: CloudMoveRequestModel,
    @User() user: UserContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<boolean> {
    return this.cloudService.Move(model, user, idempotencyKey);
  }

  @CheckPolicies((Ability) => Ability.can(CaslAction.Delete, CaslSubject.Cloud))
  @ApiOperation({
    summary: 'Delete objects',
    description:
      'Deletes one or more objects (or directories) belonging to the authenticated user.',
  })
  @ApiResponse({
    status: 200,
    description: 'Delete succeeded',
    schema: { type: 'boolean' },
  })
  @Delete('Delete')
  async Delete(
    @Body() model: CloudDeleteRequestModel,
    @User() user: UserContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<boolean> {
    return this.cloudService.Delete(model, user, undefined, idempotencyKey);
  }

  @CheckPolicies((Ability) => Ability.can(CaslAction.Update, CaslSubject.Cloud))
  @ApiOperation({
    summary: 'Update object metadata or rename',
    description:
      'Update an existing object by changing metadata or renaming the file (name only).',
  })
  @Put('Update')
  @ApiSuccessResponse(CloudObjectModel)
  @ApiResponse({
    status: 409,
    description: 'Conflict detected — target already exists',
    type: ConflictDetailsResponseModel,
  })
  async Update(
    @Body() model: CloudUpdateRequestModel,
    @User() user: UserContext,
  ): Promise<CloudObjectModel> {
    return this.cloudService.Update(model, user);
  }

  @CheckPolicies((Ability) =>
    Ability.can(CaslAction.Download, CaslSubject.Cloud),
  )
  @Get('Download')
  @Throttle(CLOUD_DOWNLOAD_THROTTLE)
  @ApiOperation({
    summary: 'Download a file for the authenticated user (streamed)',
    description:
      'Streams a file that belongs to the authenticated user. The server enforces a static per-user download speed (bytes/sec).',
  })
  @ApiQuery({
    name: 'Key',
    required: true,
    description: 'Path/key to the file (user-scoped)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Binary file stream. Content-Type and Content-Length headers set where available.',
    content: {
      'application/octet-stream': {
        schema: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'File not found' })
  async Download(
    @Query() model: CloudKeyRequestModel,
    @User() user: UserContext,
    @Res() res: Response,
  ) {
    // verify the object exists and get its metadata
    const obj = await this.cloudService.Find(model, user);

    // set headers
    res.setHeader('Content-Type', obj.MimeType || 'application/octet-stream');
    if (obj.Size) res.setHeader('Content-Length', String(obj.Size));
    const rawFilename =
      obj.Name || (model.Key ? model.Key.split('/').pop() : 'file');
    const sanitizedFilename = rawFilename
      .replace(/["\\\r\n]/g, '_')
      .replace(/[^\x20-\x7E]/g, '_');
    const encodedFilename = encodeURIComponent(rawFilename);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${sanitizedFilename}"; filename*=UTF-8''${encodedFilename}`,
    );

    // get node stream and throttle for this user (static per subscription)
    const rawStream = await this.cloudService.GetObjectReadable(model, user);
    const bytesPerSec =
      await this.cloudService.GetDownloadSpeedBytesPerSec(user);

    const throttle = new ThrottleTransform(bytesPerSec);

    const pipe = promisify(pipeline);
    try {
      await pipe(rawStream, throttle, res);
    } catch (err) {
      // can't modify headers here once started; ensure stream closed
      try {
        rawStream.destroy(err as Error);
      } catch (er) {
        new HttpException(er, HttpStatus.INTERNAL_SERVER_ERROR);
      }
    }
  }

  // ============================================================================
  // VERSIONING API
  // ============================================================================

  @ApiOperation({
    summary: 'List previous versions of a file',
    description:
      'Returns the version history (non-current versions) for the given file key. Requires S3 bucket versioning to be enabled.',
  })
  @Get('Versions')
  @ApiSuccessResponse(CloudVersionListResponseModel)
  async ListVersions(
    @Query() model: CloudKeyRequestModel,
    @User() user: UserContext,
  ): Promise<CloudVersionListResponseModel> {
    return this.cloudService.ListVersions(model, user);
  }

  @CheckPolicies((Ability) => Ability.can(CaslAction.Update, CaslSubject.Cloud))
  @ApiOperation({
    summary: 'Restore a previous version of a file',
    description:
      'Copies the specified old version as the new current version. The previous current version becomes a non-current version.',
  })
  @Put('Versions/Restore')
  async RestoreVersion(
    @Body() model: CloudRestoreVersionRequestModel,
    @User() user: UserContext,
  ): Promise<void> {
    return this.cloudService.RestoreVersion(model, user);
  }

  @CheckPolicies((Ability) => Ability.can(CaslAction.Delete, CaslSubject.Cloud))
  @ApiOperation({
    summary: 'Delete a specific version of a file',
    description:
      'Permanently deletes a non-current version. Cannot delete the current (latest) version.',
  })
  @Delete('Versions')
  async DeleteVersion(
    @Body() model: CloudDeleteVersionRequestModel,
    @User() user: UserContext,
  ): Promise<void> {
    return this.cloudService.DeleteVersion(model, user);
  }
}
