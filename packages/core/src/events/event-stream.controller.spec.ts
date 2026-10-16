import { Test, TestingModule } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { AuthenticatedActor } from '../auth/authenticated-actor';
import { EventStreamController } from './event-stream.controller';
import { EventStreamService } from './event-stream.service';

describe('EventStreamController', () => {
  it('opens the stream for the token-verified organization with the raw request/response pair', async () => {
    const eventStream = { openStream: jest.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [EventStreamController],
      providers: [{ provide: EventStreamService, useValue: eventStream }],
    }).compile();

    const controller = moduleRef.get<EventStreamController>(EventStreamController);
    const actor: AuthenticatedActor = {
      organizationId: 'org-a',
      userId: 'user-1',
    } as AuthenticatedActor;
    const req = { headers: {} } as unknown as Request;
    const res = {} as unknown as Response;

    controller.stream(actor, req, res);

    // The organization NEVER comes from the request — only from the verified
    // token (tenancy R6) — and the controller delegates the whole stream.
    expect(eventStream.openStream).toHaveBeenCalledWith('org-a', req, res);
  });
});
