import { BadRequestException } from '@nestjs/common';
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

  it('rejects a missing Idempotency-Key header with 400 and does not call the service', async () => {
    await expect(
      controller.create(
        { eventType: EventType.BANK_ACCOUNT_CHANGE, payload: {} },
        undefined,
        res,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(eventsService.createEvent).not.toHaveBeenCalled();
  });

  it('delegates the header and DTO to the service and applies the stored status', async () => {
    const submitted: SubmissionResult = { httpStatus: 201, body: { id: 'evt-1', status: 'received' } };
    eventsService.createEvent.mockResolvedValue(submitted);

    const body = await controller.create(
      { eventType: EventType.BANK_ACCOUNT_CHANGE, payload: { employeeId: 'emp-1' } },
      '  k-1  ',
      res,
    );

    expect(eventsService.createEvent).toHaveBeenCalledWith({
      eventType: EventType.BANK_ACCOUNT_CHANGE,
      payload: { employeeId: 'emp-1' },
      idempotencyKey: 'k-1', // trimmed
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(body).toEqual(submitted.body);
  });
});