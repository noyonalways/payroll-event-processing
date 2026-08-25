import { Test, TestingModule } from '@nestjs/testing';
import { Response } from 'express';
import { EventsController } from './events.controller';
import { EventsService, SubmissionResult } from './events.service';
import { EventType } from './event-type';

describe('EventsController', () => {
  let controller: EventsController;
  const eventsService = { createEvent: jest.fn() };
  const res = { status: jest.fn().mockReturnThis() } as unknown as Response;

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [EventsController],
      providers: [{ provide: EventsService, useValue: eventsService }],
    }).compile();

    controller = moduleRef.get<EventsController>(EventsController);
  });

  it('delegates the DTO and Idempotency-Key to the service and applies the stored status', async () => {
    const submitted: SubmissionResult = {
      httpStatus: 201,
      body: { id: 'evt-1', status: 'received' },
    };
    eventsService.createEvent.mockResolvedValue(submitted);

    const body = await controller.create(
      { eventType: EventType.BANK_ACCOUNT_CHANGE, payload: { employeeId: 'emp-1' } },
      'k-1',
      res,
    );

    expect(eventsService.createEvent).toHaveBeenCalledWith({
      eventType: EventType.BANK_ACCOUNT_CHANGE,
      payload: { employeeId: 'emp-1' },
      idempotencyKey: 'k-1',
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(body).toEqual(submitted.body);
  });

  it('applies the service-supplied status generically (not a hard-coded 201)', async () => {
    // A replay path resolves through the same httpStatus/body contract; the
    // controller must echo whatever the service returns, never assume 201.
    eventsService.createEvent.mockResolvedValue({
      httpStatus: 200,
      body: { id: 'evt-1', status: 'received' },
    });

    await controller.create(
      { eventType: EventType.BANK_ACCOUNT_CHANGE, payload: { employeeId: 'emp-1' } },
      'k-1',
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
  });
});