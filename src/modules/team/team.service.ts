import { Injectable, HttpException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { plainToInstance } from 'class-transformer';
import { TeamEntity } from '@entities/team.entity';
import { TeamMemberEntity } from '@entities/team-member.entity';
import { UserEntity } from '@entities/user.entity';
import { TeamRole, TeamStatus } from '@common/enums';
import { RedisService } from '@modules/redis/redis.service';
import { TeamKeys } from '@modules/redis/redis.keys';
import {
  TEAM_LIST_CACHE_TTL,
  TEAM_DETAIL_CACHE_TTL,
  TEAM_MEMBERSHIP_CACHE_TTL,
} from '@modules/redis/redis.ttl';
import { slugify } from '@common/helpers/cast.helper';
import {
  TeamCreateRequestModel,
  TeamUpdateRequestModel,
  TeamResponseModel,
  TeamDetailResponseModel,
} from './team.model';

@Injectable()
export class TeamService {
  constructor(
    @InjectRepository(TeamEntity)
    private readonly teamRepository: Repository<TeamEntity>,
    @InjectRepository(TeamMemberEntity)
    private readonly teamMemberRepository: Repository<TeamMemberEntity>,
    private readonly RedisService: RedisService,
  ) {}

  async Create(
    Model: TeamCreateRequestModel,
    User: UserContext,
  ): Promise<TeamResponseModel> {
    // Future: await this.ValidateTeamCreationAllowed(User);

    const slug = slugify(Model.Name);

    const existing = await this.teamRepository.findOne({
      where: { Slug: slug },
    });
    if (existing) {
      throw new HttpException('A team with this name already exists', 409);
    }

    const queryRunner =
      this.teamRepository.manager.connection.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    let team: TeamEntity;
    try {
      team = await queryRunner.manager.save(
        new TeamEntity({
          Name: Model.Name,
          Slug: slug,
          Description: Model.Description,
        }),
      );
      await queryRunner.manager.save(
        new TeamMemberEntity({
          Team: team,
          User: { Id: User.Id } as UserEntity,
          Role: TeamRole.OWNER,
          JoinedAt: new Date(),
        }),
      );
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    await this.InvalidateUserTeamsCache(User.Id);

    // Warm membership cache so the guard finds it immediately
    await this.RedisService.Set(
      TeamKeys.Membership(team.Id, User.Id),
      {
        Role: TeamRole.OWNER,
        TeamStatus: TeamStatus.ACTIVE,
        TeamSlug: slug,
        TeamName: team.Name,
      },
      TEAM_MEMBERSHIP_CACHE_TTL,
    );

    return plainToInstance(TeamResponseModel, {
      ...team,
      MemberCount: 1,
      MyRole: TeamRole.OWNER,
    });
  }

  async List(User: UserContext): Promise<TeamResponseModel[]> {
    const cacheKey = TeamKeys.UserTeams(User.Id);
    const cached = await this.RedisService.Get<TeamResponseModel[]>(cacheKey);
    if (cached) return cached;

    const memberships = await this.teamMemberRepository.find({
      where: { User: { Id: User.Id } },
      relations: ['Team'],
    });

    const validMemberships = memberships.filter(
      (m) => m.Team && !m.Team.DeletedAt,
    );

    const teamIds = validMemberships.map((m) => m.Team.Id);
    const countRows: { teamId: string; count: string }[] = teamIds.length
      ? await this.teamMemberRepository
          .createQueryBuilder('tm')
          .select('tm.TeamId', 'teamId')
          .addSelect('COUNT(tm.Id)', 'count')
          .where('tm.TeamId IN (:...teamIds)', { teamIds })
          .groupBy('tm.TeamId')
          .getRawMany()
      : [];
    const countMap = new Map(
      countRows.map((r) => [r.teamId, parseInt(r.count, 10)]),
    );

    const result: TeamResponseModel[] = validMemberships.map((membership) =>
      plainToInstance(TeamResponseModel, {
        ...membership.Team,
        MemberCount: countMap.get(membership.Team.Id) ?? 0,
        MyRole: membership.Role,
      }),
    );

    await this.RedisService.Set(cacheKey, result, TEAM_LIST_CACHE_TTL);
    return result;
  }

  async Find(
    TeamId: string,
    User: UserContext,
  ): Promise<TeamDetailResponseModel> {
    const cacheKey = TeamKeys.Detail(TeamId);
    const cached =
      await this.RedisService.Get<TeamDetailResponseModel>(cacheKey);
    if (cached) return cached;

    const teamResult = await this.teamRepository
      .createQueryBuilder('t')
      .leftJoin('t.Members', 'tm')
      .select([
        't.Id',
        't.Name',
        't.Slug',
        't.Description',
        't.Image',
        't.Status',
        't.StorageLimitBytes',
        't.MaxUploadSizeBytes',
        't.MaxObjectCount',
        't.MaxMembers',
        't.Features',
        't.CreatedAt',
        't.UpdatedAt',
      ])
      .addSelect('COUNT(tm.Id)', 'MemberCount')
      .where('t.Id = :TeamId', { TeamId })
      .groupBy('t.Id')
      .getRawAndEntities();

    if (!teamResult.entities[0]) {
      throw new HttpException('Team not found', 404);
    }
    const team = teamResult.entities[0];
    const memberCount = parseInt(teamResult.raw[0]?.MemberCount ?? '0', 10);

    const membership = await this.teamMemberRepository.findOne({
      where: { Team: { Id: TeamId }, User: { Id: User.Id } },
    });

    const result = plainToInstance(TeamDetailResponseModel, {
      ...team,
      MemberCount: memberCount,
      MyRole: membership?.Role,
    });

    await this.RedisService.Set(cacheKey, result, TEAM_DETAIL_CACHE_TTL);
    return result;
  }

  async Update(
    TeamId: string,
    Model: TeamUpdateRequestModel,
    User: UserContext,
  ): Promise<TeamResponseModel> {
    const team = await this.teamRepository.findOne({ where: { Id: TeamId } });
    if (!team) {
      throw new HttpException('Team not found', 404);
    }

    if (Model.Name && Model.Name !== team.Name) {
      const newSlug = slugify(Model.Name);
      const existing = await this.teamRepository.findOne({
        where: { Slug: newSlug },
      });
      if (existing && existing.Id !== TeamId) {
        throw new HttpException('A team with this name already exists', 409);
      }
      team.Name = Model.Name;
      team.Slug = newSlug;
    }

    if (Model.Description !== undefined) team.Description = Model.Description;
    if (Model.Image !== undefined) team.Image = Model.Image;

    await this.teamRepository.save(team);

    await this.InvalidateTeamCaches(TeamId);

    const membership = await this.teamMemberRepository.findOne({
      where: { Team: { Id: TeamId }, User: { Id: User.Id } },
    });

    return plainToInstance(TeamResponseModel, {
      ...team,
      MyRole: membership?.Role,
    });
  }

  async Delete(TeamId: string, User: UserContext): Promise<boolean> {
    const membership = await this.teamMemberRepository.findOne({
      where: { Team: { Id: TeamId }, User: { Id: User.Id } },
    });
    if (!membership || membership.Role !== TeamRole.OWNER) {
      throw new HttpException('Only the team owner can delete the team', 403);
    }

    const team = await this.teamRepository.findOne({ where: { Id: TeamId } });
    if (!team) {
      throw new HttpException('Team not found', 404);
    }

    await this.teamRepository.softDelete(TeamId);

    // Invalidate caches for all members
    const members = await this.teamMemberRepository.find({
      where: { Team: { Id: TeamId } },
      relations: ['User'],
    });
    await Promise.all(
      members.map((member) => this.InvalidateUserTeamsCache(member.User.Id)),
    );
    await this.InvalidateTeamCaches(TeamId);

    return true;
  }

  private async InvalidateTeamCaches(teamId: string): Promise<void> {
    await this.RedisService.Delete(TeamKeys.Detail(teamId));
    await this.RedisService.DeleteByPattern(TeamKeys.MembershipPattern(teamId));
  }

  private async InvalidateUserTeamsCache(userId: string): Promise<void> {
    await this.RedisService.Delete(TeamKeys.UserTeams(userId));
  }
}
