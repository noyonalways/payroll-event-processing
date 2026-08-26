import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Response } from 'express';
import { EventsController } from './events.controller';
import { EventsService, SubmissionResult } from './events.service';
import { EventStatusResponseDto } from './dto/event-status-response.dto';
import { EventType } from './event-type';

describe('EventsController', () => {
  let controller: EventsController;
  const eventsService = { createEvent: jest.fn(), getEventStatus: jest.fn() };
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

  describe('GET /events/:id (event-status-api)', () => {
    it('returns the service result for the path id', async () => {
      const status: EventStatusResponseDto = {
        id: 'evt-1',
        eventType: EventType.BANK_ACCOUNT_CHANGE,
        employeeId: 'emp-1',
        sequence: 3,
        status: 'success',
        payload: { employeeId: 'emp-1' },
        createdAt: '2026-08-26T00:40:12.000Z',
        updatedAt: '2026-08-26T00:40:13.000Z',
        processedAt: '2026-08-26T00:40:13.000Z',
        result: { reference: 'SIM-1' },
        attempts: [
          {
            attemptNumber: 1,
            status: 'SUCCESS',
            errorType: null,
            failedReason: null,
            result: { reference: 'SIM-1' },
            createdAt: '2026-08-26T00:40:13.000Z',
          },
        ],
      };
      eventsService.getEventStatus.mockResolvedValue(status);

      const result = await controller.getStatus('evt-1');

      expect(eventsService.getEventStatus).toHaveBeenCalledWith('evt-1');
      expect(result).toBe(status);
    });

    it('propagates a service rejection (404 body shape is the global filter’s job)', async () => {
      const notFound = new NotFoundException('Event with id nope not found');
      eventsService.getEventStatus.mockRejectedValue(notFound);

      await expect(controller.getStatus('nope')).rejects.toBe(notFound);
    });
  });
});