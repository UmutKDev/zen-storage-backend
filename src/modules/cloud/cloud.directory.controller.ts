import { Body, Controller, Delete, Headers, Post, Put } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiTags,
  ApiHeader,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { CloudService } from './cloud.service';
import {
  DirectoryCreateRequestModel,
  DirectoryRenameRequestModel,
  DirectoryDeleteRequestModel,
  DirectoryUnlockRequestModel,
  DirectoryUnlockResponseModel,
  DirectoryLockRequestModel,
  DirectoryConvertToEncryptedRequestModel,
  DirectoryDecryptRequestModel,
  DirectoryResponseModel,
  DirectoryHideRequestModel,
  DirectoryUnhideRequestModel,
  DirectoryRevealRequestModel,
  DirectoryRevealResponseModel,
  DirectoryConcealRequestModel,
  ConflictDetailsResponseModel,
} from './cloud.model';
import { ApiSuccessResponse } from '@common/decorators/response.decorator';
import { User } from '@common/decorators/user.decorator';
import {
  FOLDER_SESSION_HEADER,
  FOLDER_PASSPHRASE_HEADER,
} from './cloud.constants';
import { TEAM_ID_HEADER } from '@modules/team/guards/team-context.guard';
import { CheckPolicies } from '@modules/authentication/casl/check-policies.decorator';
import { CaslAction, CaslSubject } from '@common/enums';

@Controller('Cloud/Directory')
@ApiTags('Cloud / Directory')
@ApiCookieAuth()
@ApiHeader({
  name: TEAM_ID_HEADER,
  required: false,
  description:
    'Optional team ID. When provided, directory operations target the team storage.',
})
export class CloudDirectoryController {
  constructor(private readonly cloudService: CloudService) {}

  @CheckPolicies((Ability) =>
    Ability.can(CaslAction.Create, CaslSubject.CloudDirectory),
  )
  @ApiOperation({
    summary: 'Create a directory',
    description:
      'Creates a new directory. For encrypted directories, set IsEncrypted=true and provide passphrase via X-Folder-Passphrase header.',
  })
  @Post()
  @ApiHeader({
    name: FOLDER_PASSPHRASE_HEADER,
    required: false,
    description: 'Passphrase for encrypted directory (min 8 chars)',
  })
  @ApiHeader({
    name: FOLDER_SESSION_HEADER,
    required: false,
    description: 'Session token for encrypted folder access',
  })
  @ApiSuccessResponse(DirectoryResponseModel)
  @ApiResponse({
    status: 409,
    description: 'Conflict detected — directory already exists',
    type: ConflictDetailsResponseModel,
  })
  async DirectoryCreate(
    @Body() model: DirectoryCreateRequestModel,
    @User() user: UserContext,
    @Headers(FOLDER_PASSPHRASE_HEADER) passphrase?: string,
    @Headers(FOLDER_SESSION_HEADER) sessionToken?: string,
  ): Promise<DirectoryResponseModel> {
    return this.cloudService.DirectoryCreate(
      model,
      passphrase,
      user,
      sessionToken,
    );
  }

  @CheckPolicies((Ability) =>
    Ability.can(CaslAction.Update, CaslSubject.CloudDirectory),
  )
  @ApiOperation({
    summary: 'Rename a directory',
    description:
      'Renames a directory. For encrypted directories, provide passphrase via X-Folder-Passphrase header.',
  })
  @Put('Rename')
  @ApiHeader({
    name: FOLDER_PASSPHRASE_HEADER,
    required: false,
    description: 'Passphrase for encrypted directory',
  })
  @ApiHeader({
    name: FOLDER_SESSION_HEADER,
    required: false,
    description: 'Session token for encrypted folder access',
  })
  @ApiSuccessResponse(DirectoryResponseModel)
  @ApiResponse({
    status: 409,
    description: 'Conflict detected — target directory already exists',
    type: ConflictDetailsResponseModel,
  })
  async DirectoryRename(
    @Body() model: DirectoryRenameRequestModel,
    @User() user: UserContext,
    @Headers(FOLDER_PASSPHRASE_HEADER) passphrase?: string,
    @Headers(FOLDER_SESSION_HEADER) sessionToken?: string,
  ): Promise<DirectoryResponseModel> {
    return this.cloudService.DirectoryRename(
      model,
      passphrase,
      user,
      sessionToken,
    );
  }

  @CheckPolicies((Ability) =>
    Ability.can(CaslAction.Delete, CaslSubject.CloudDirectory),
  )
  @ApiOperation({
    summary: 'Delete a directory',
    description:
      'Deletes a directory and all its contents. For encrypted directories, provide passphrase via X-Folder-Passphrase header.',
  })
  @Delete()
  @ApiHeader({
    name: FOLDER_PASSPHRASE_HEADER,
    required: false,
    description: 'Passphrase for encrypted directory',
  })
  @ApiHeader({
    name: FOLDER_SESSION_HEADER,
    required: false,
    description: 'Session token for encrypted folder access',
  })
  @ApiResponse({
    status: 200,
    description: 'Directory deleted',
    schema: { type: 'boolean' },
  })
  async DirectoryDelete(
    @Body() model: DirectoryDeleteRequestModel,
    @User() user: UserContext,
    @Headers(FOLDER_PASSPHRASE_HEADER) passphrase?: string,
    @Headers(FOLDER_SESSION_HEADER) sessionToken?: string,
  ): Promise<boolean> {
    return this.cloudService.DirectoryDelete(
      model,
      passphrase,
      user,
      sessionToken,
    );
  }

  @CheckPolicies((Ability) =>
    Ability.can(CaslAction.Execute, CaslSubject.CloudDirectory),
  )
  @ApiOperation({
    summary: 'Unlock an encrypted directory',
    description:
      'Validates passphrase and creates a session token for subsequent access. The session token should be passed via X-Folder-Session header in subsequent requests.',
  })
  @Post('Unlock')
  @ApiHeader({
    name: FOLDER_PASSPHRASE_HEADER,
    required: true,
    description: 'Passphrase for encrypted directory (min 8 chars)',
  })
  @ApiSuccessResponse(DirectoryUnlockResponseModel)
  async DirectoryUnlock(
    @Body() model: DirectoryUnlockRequestModel,
    @User() user: UserContext,
    @Headers(FOLDER_PASSPHRASE_HEADER) passphrase?: string,
  ): Promise<DirectoryUnlockResponseModel> {
    return this.cloudService.DirectoryUnlock(model, passphrase, user);
  }

  @CheckPolicies((Ability) =>
    Ability.can(CaslAction.Execute, CaslSubject.CloudDirectory),
  )
  @ApiOperation({
    summary: 'Lock an encrypted directory',
    description: 'Invalidates the session token for an encrypted directory.',
  })
  @Post('Lock')
  @ApiResponse({
    status: 200,
    description: 'Directory locked',
    schema: { type: 'boolean' },
  })
  async DirectoryLock(
    @Body() model: DirectoryLockRequestModel,
    @User() user: UserContext,
  ): Promise<boolean> {
    return this.cloudService.DirectoryLock(model, user);
  }

  @CheckPolicies((Ability) =>
    Ability.can(CaslAction.Execute, CaslSubject.CloudDirectory),
  )
  @ApiOperation({
    summary: 'Convert a directory to encrypted',
    description:
      'Marks an existing directory as encrypted. Provide passphrase via X-Folder-Passphrase header.',
  })
  @Post('Encrypt')
  @ApiHeader({
    name: FOLDER_PASSPHRASE_HEADER,
    required: true,
    description: 'Passphrase for encryption (min 8 chars)',
  })
  @ApiHeader({
    name: FOLDER_SESSION_HEADER,
    required: false,
    description: 'Session token for encrypted folder access',
  })
  @ApiSuccessResponse(DirectoryResponseModel)
  async DirectoryConvertToEncrypted(
    @Body() model: DirectoryConvertToEncryptedRequestModel,
    @User() user: UserContext,
    @Headers(FOLDER_PASSPHRASE_HEADER) passphrase?: string,
    @Headers(FOLDER_SESSION_HEADER) sessionToken?: string,
  ): Promise<DirectoryResponseModel> {
    return this.cloudService.DirectoryConvertToEncrypted(
      model,
      passphrase,
      user,
      sessionToken,
    );
  }

  @CheckPolicies((Ability) =>
    Ability.can(CaslAction.Execute, CaslSubject.CloudDirectory),
  )
  @ApiOperation({
    summary: 'Remove encryption from a directory',
    description:
      'Removes encryption from a directory (keeps files). Provide passphrase via X-Folder-Passphrase header.',
  })
  @Post('Decrypt')
  @ApiHeader({
    name: FOLDER_PASSPHRASE_HEADER,
    required: true,
    description: 'Passphrase for decryption',
  })
  @ApiHeader({
    name: FOLDER_SESSION_HEADER,
    required: false,
    description: 'Session token for encrypted folder access',
  })
  @ApiSuccessResponse(DirectoryResponseModel)
  async DirectoryDecrypt(
    @Body() model: DirectoryDecryptRequestModel,
    @User() user: UserContext,
    @Headers(FOLDER_PASSPHRASE_HEADER) passphrase?: string,
    @Headers(FOLDER_SESSION_HEADER) sessionToken?: string,
  ): Promise<DirectoryResponseModel> {
    return this.cloudService.DirectoryDecrypt(
      model,
      passphrase,
      user,
      sessionToken,
    );
  }

  // ============================================================================
  // HIDDEN DIRECTORIES API
  // ============================================================================

  @CheckPolicies((Ability) =>
    Ability.can(CaslAction.Execute, CaslSubject.CloudDirectory),
  )
  @ApiOperation({
    summary: 'Hide a directory',
    description:
      'Marks a directory as hidden. Hidden directories are not shown in directory listings unless a valid hidden session token is provided. Provide passphrase via X-Folder-Passphrase header.',
  })
  @Post('Hide')
  @ApiHeader({
    name: FOLDER_PASSPHRASE_HEADER,
    required: true,
    description: 'Passphrase for hidden directory (min 8 chars)',
  })
  @ApiSuccessResponse(DirectoryResponseModel)
  async DirectoryHide(
    @Body() model: DirectoryHideRequestModel,
    @User() user: UserContext,
    @Headers(FOLDER_PASSPHRASE_HEADER) passphrase?: string,
  ): Promise<DirectoryResponseModel> {
    return this.cloudService.DirectoryHide(model, passphrase, user);
  }

  @CheckPolicies((Ability) =>
    Ability.can(CaslAction.Execute, CaslSubject.CloudDirectory),
  )
  @ApiOperation({
    summary: 'Unhide a directory',
    description:
      'Removes hidden status from a directory. Provide passphrase via X-Folder-Passphrase header.',
  })
  @Post('Unhide')
  @ApiHeader({
    name: FOLDER_PASSPHRASE_HEADER,
    required: true,
    description: 'Passphrase for hidden directory',
  })
  @ApiSuccessResponse(DirectoryResponseModel)
  async DirectoryUnhide(
    @Body() model: DirectoryUnhideRequestModel,
    @User() user: UserContext,
    @Headers(FOLDER_PASSPHRASE_HEADER) passphrase?: string,
  ): Promise<DirectoryResponseModel> {
    return this.cloudService.DirectoryUnhide(model, passphrase, user);
  }

  @CheckPolicies((Ability) =>
    Ability.can(CaslAction.Execute, CaslSubject.CloudDirectory),
  )
  @ApiOperation({
    summary: 'Reveal hidden directories',
    description:
      'Validates passphrase and creates a session token for viewing hidden directories. The session token should be passed via X-Hidden-Session header in subsequent list requests.',
  })
  @Post('Reveal')
  @ApiHeader({
    name: FOLDER_PASSPHRASE_HEADER,
    required: true,
    description: 'Passphrase for hidden directory (min 8 chars)',
  })
  @ApiSuccessResponse(DirectoryRevealResponseModel)
  async DirectoryReveal(
    @Body() model: DirectoryRevealRequestModel,
    @User() user: UserContext,
    @Headers(FOLDER_PASSPHRASE_HEADER) passphrase?: string,
  ): Promise<DirectoryRevealResponseModel> {
    return this.cloudService.DirectoryReveal(model, passphrase, user);
  }

  @CheckPolicies((Ability) =>
    Ability.can(CaslAction.Execute, CaslSubject.CloudDirectory),
  )
  @ApiOperation({
    summary: 'Conceal hidden directories',
    description:
      'Invalidates the session token for hidden directories, hiding them from listings again.',
  })
  @Post('Conceal')
  @ApiResponse({
    status: 200,
    description: 'Directory concealed',
    schema: { type: 'boolean' },
  })
  async DirectoryConceal(
    @Body() model: DirectoryConcealRequestModel,
    @User() user: UserContext,
  ): Promise<boolean> {
    return this.cloudService.DirectoryConceal(model, user);
  }
}
