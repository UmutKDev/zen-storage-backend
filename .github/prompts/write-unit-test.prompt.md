---
name: Write Unit Test
description: Generate a complete unit test file for a service method following project mock patterns
argument-hint: Service class name and method to test (e.g. "CloudListService.List")
agent: agent
---

Generate a comprehensive unit test for the specified service method. Follow the project's established mock patterns exactly.

# Input
Target: $input (format: "ServiceName.MethodName" or just "ServiceName" for full test file)

# Test File Structure

## File Location
`src/modules/{module-name}/{service-file}.spec.ts`

## Imports
```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { {ServiceName} } from './{service-file}.service';
import { {Entity}Entity } from '@entities/{entity}.entity';
import { Role, Status, TeamRole } from '@common/enums';
import { asyncLocalStorage } from '@common/context/context.service';
```

## Mock Setup
```typescript
// Repository mock with full QueryBuilder chain
const mockQueryBuilder = {
  where: jest.fn().mockReturnThis(),
  andWhere: jest.fn().mockReturnThis(),
  leftJoinAndSelect: jest.fn().mockReturnThis(),
  addSelect: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  addOrderBy: jest.fn().mockReturnThis(),
  skip: jest.fn().mockReturnThis(),
  take: jest.fn().mockReturnThis(),
  withDeleted: jest.fn().mockReturnThis(),
  getOne: jest.fn(),
  getMany: jest.fn(),
  getManyAndCount: jest.fn(),
};

const mockRepo = {
  createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
  findOne: jest.fn(),
  save: jest.fn(),
  update: jest.fn(),
  softDelete: jest.fn(),
  restore: jest.fn(),
};

const mockRedisService = {
  Get: jest.fn().mockResolvedValue(null),   // cache miss by default
  Set: jest.fn().mockResolvedValue(undefined),
  Delete: jest.fn().mockResolvedValue(undefined),
  DeleteByPattern: jest.fn().mockResolvedValue(undefined),
};

// Standard test fixtures
const testUser: UserContext = {
  Id: 'user-uuid-test',
  Email: 'test@example.com',
  FullName: 'Test User',
  Role: Role.USER,
  Status: Status.ACTIVE,
};

const testTeamUser: UserContext = {
  ...testUser,
  TeamId: 'team-uuid-test',
  TeamRole: TeamRole.MEMBER,
};

const mockEntity = {
  Id: 'entity-uuid-test',
  UserId: testUser.Id,
  // Add entity-specific fields
  CreatedAt: new Date('2024-01-01'),
  UpdatedAt: new Date('2024-01-01'),
  DeletedAt: null,
};
```

## Test Suite Structure
```typescript
describe('{ServiceName}', () => {
  let service: {ServiceName};

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {ServiceName},
        { provide: getRepositoryToken({Entity}Entity), useValue: mockRepo },
        { provide: RedisService, useValue: mockRedisService },
        // Add other mocked dependencies
      ],
    }).compile();

    service = module.get<{ServiceName}>({ServiceName});
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('{MethodName}', () => {
    // Happy path
    it('should return {description} successfully', async () => {
      mockQueryBuilder.getManyAndCount.mockResolvedValue([[mockEntity], 1]);

      const mockRequest = { TotalRowCount: 0 } as any;
      await asyncLocalStorage.run(new Map([['request', mockRequest]]), async () => {
        const result = await service.{MethodName}(mockModel, testUser);
        expect(result).toHaveLength(1);
        expect(mockRequest.TotalRowCount).toBe(1);
      });
    });

    // Not found case
    it('should throw NOT_FOUND when entity does not exist', async () => {
      mockQueryBuilder.getOne.mockResolvedValue(null);

      await expect(service.{MethodName}('nonexistent-id', testUser))
        .rejects.toThrow(HttpException);

      await expect(service.{MethodName}('nonexistent-id', testUser))
        .rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });

    // Authorization case (if applicable)
    it('should throw FORBIDDEN when entity belongs to another user', async () => {
      const otherUserEntity = { ...mockEntity, UserId: 'other-user-id' };
      mockQueryBuilder.getOne.mockResolvedValue(otherUserEntity);

      await expect(service.{MethodName}(mockEntity.Id, testUser))
        .rejects.toThrow(HttpException);
    });

    // Team context case (if applicable)
    it('should work with team context', async () => {
      mockQueryBuilder.getManyAndCount.mockResolvedValue([[mockEntity], 1]);

      const result = await service.{MethodName}(mockModel, testTeamUser);
      expect(result).toBeDefined();
    });
  });
});
```

# Rules for Generated Tests

1. **Always** `jest.clearAllMocks()` in `afterEach`
2. **Always** test happy path + at least one error case per method
3. **Always** use `asyncLocalStorage.run(...)` when testing methods that set `TotalRowCount`
4. **Always** mock Redis as cache miss (`null`) by default — test cache hit separately if needed
5. **Never** call real database or S3 services
6. For `Create` tests: verify the saved entity has the correct `UserId` from `user.Id`
7. For `Delete` tests: verify `softDelete` is called (not `delete`)
8. For cache tests: verify `DeleteByPattern` is called on mutations
