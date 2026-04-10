---
name: Test Instructions
description: Unit and E2E test patterns for this project
applyTo: "**/*.spec.ts, **/*.e2e-spec.ts"
---

# Test Conventions

## Unit Test Structure

### Service Mock Pattern
```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SomeService } from './some.service';
import { SomeEntity } from '@entities/some.entity';
import { Role, Status } from '@common/enums';

// Mock all dependencies as plain object literals
const mockRepo = {
  createQueryBuilder: jest.fn(),
  findOne: jest.fn(),
  save: jest.fn(),
  softDelete: jest.fn(),
};

const mockRedisService = {
  Get: jest.fn(),
  Set: jest.fn(),
  Delete: jest.fn(),
  DeleteByPattern: jest.fn(),
};

describe('SomeService', () => {
  let service: SomeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SomeService,
        { provide: getRepositoryToken(SomeEntity), useValue: mockRepo },
        { provide: RedisService, useValue: mockRedisService },
      ],
    }).compile();

    service = module.get<SomeService>(SomeService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });
```

---

## UserContext Test Fixture

Always use this standard fixture — extend as needed:
```typescript
const testUser: UserContext = {
  Id: 'user-uuid-1',
  Email: 'test@example.com',
  FullName: 'Test User',
  Role: Role.USER,
  Status: Status.ACTIVE,
};

const testAdminUser: UserContext = {
  ...testUser,
  Id: 'admin-uuid-1',
  Role: Role.ADMIN,
};

const testTeamUser: UserContext = {
  ...testUser,
  TeamId: 'team-uuid-1',
  TeamRole: TeamRole.MEMBER,
};
```

---

## AsyncLocalStorage in Tests

When testing services that call `asyncLocalStorage.getStore()`, seed the store:

```typescript
import { asyncLocalStorage } from '@common/context/context.service';

it('should set TotalRowCount on paginated list', async () => {
  const mockRequest = { TotalRowCount: 0 } as any;

  await asyncLocalStorage.run(new Map([['request', mockRequest]]), async () => {
    const result = await service.List({ Skip: 0, Take: 20 }, testUser);
    expect(mockRequest.TotalRowCount).toBe(5);
    expect(result).toHaveLength(5);
  });
});
```

---

## QueryBuilder Mock Pattern

For services using `createQueryBuilder`, chain the mock:

```typescript
const mockQueryBuilder = {
  where: jest.fn().mockReturnThis(),
  andWhere: jest.fn().mockReturnThis(),
  leftJoinAndSelect: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  skip: jest.fn().mockReturnThis(),
  take: jest.fn().mockReturnThis(),
  withDeleted: jest.fn().mockReturnThis(),
  getOne: jest.fn(),
  getMany: jest.fn(),
  getManyAndCount: jest.fn(),
};

mockRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder);
mockQueryBuilder.getManyAndCount.mockResolvedValue([[mockEntity], 1]);
```

---

## Test Cases Pattern

```typescript
describe('Create', () => {
  it('should create and return ResponseModel', async () => {
    mockRepo.save.mockResolvedValue(mockEntity);

    const result = await service.Create(mockCreateDto, testUser);

    expect(mockRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ UserId: testUser.Id }),
    );
    expect(result).toMatchObject({ Id: mockEntity.Id });
  });

  it('should throw HttpException when name already exists', async () => {
    mockQueryBuilder.getOne.mockResolvedValue(mockEntity);  // simulate conflict

    await expect(service.Create(mockCreateDto, testUser))
      .rejects.toThrow(HttpException);
  });
});
```

---

## S3 Test Setup

For services touching `CloudS3Service` or signed URL generation:

```typescript
beforeAll(() => {
  process.env.S3_PROTOCOL_SIGNED_URL_PROCESSING = 'false';
  process.env.S3_ENDPOINT = 'https://s3.example.com';
  process.env.S3_REGION = 'us-east-1';
  process.env.S3_BUCKET = 'test-bucket';
});
```

---

## E2E Tests

E2E tests import `AppModule` (not feature modules):

```typescript
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import * as request from 'supertest';

let app: INestApplication;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = module.createNestApplication();
  await app.init();
});

afterAll(async () => {
  await app.close();
});

it('POST /Api/v1/Some/Create', async () => {
  const res = await request(app.getHttpServer())
    .post('/Api/v1/Some/Create')
    .set('Cookie', `session=${testSessionToken}`)
    .send({ Name: 'Test' })
    .expect(201);

  expect(res.body.Result).toHaveProperty('Id');
  expect(res.body.Status.Code).toBe(200);
});
```

---

## Test File Location

- Unit tests: `src/**/*.spec.ts` (co-located with source)
- E2E tests: `test/**/*.e2e-spec.ts`

## Run Commands

```bash
yarn test          # all unit tests
yarn test:watch    # watch mode
yarn test:e2e      # end-to-end tests
yarn test:cov      # coverage report
```

---

## Anti-Patterns

```typescript
// ❌ Real database calls in unit tests
const module = await Test.createTestingModule({
  imports: [TypeOrmModule.forRoot({ ... })],  // real DB connection
});

// ✅ Mock the repository
{ provide: getRepositoryToken(SomeEntity), useValue: mockRepo }

// ❌ Not clearing mocks between tests — can cause cross-test contamination
// ✅ Always afterEach(() => jest.clearAllMocks())

// ❌ Testing TransformInterceptor response shape in unit tests (it's a global concern)
// ✅ Test that the service returns the correct model, not { Result, Status } shape
```
