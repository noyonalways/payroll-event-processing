# Spec Delta

## MODIFIED Requirements

### Requirement: The UI can submit each supported event type
The system SHALL provide a submission form that targets `POST /events` with a mandatory `Idempotency-Key` header and an `Authorization: Bearer <accessToken>` header carrying the signed-in user's access token. For each supported event type (`BANK_ACCOUNT_CHANGE`, `ADDRESS_CHANGE`, `SALARY_CHANGE`) the form SHALL render exactly the required fields defined for that type by the `event-submission` capability, and SHALL construct the request body as `{ "eventType": <type>, "payload": { <fields> } }`. Every submit SHALL generate a fresh UUID as the `Idempotency-Key` header value. On HTTP `201` the UI SHALL display the returned `id` and `status` and add the event to the tracked list. On HTTP `400` the UI SHALL surface the structured error message without losing the entered values. A submission SHALL only be possible while a session is active; the submission form SHALL NOT be reachable without one.

#### Scenario: Submit BANK_ACCOUNT_CHANGE
- **WHEN** the signed-in user selects `BANK_ACCOUNT_CHANGE`, fills `employeeId`, `effectiveDate`, and `iban`, and submits
- **THEN** the UI SHALL send `POST /events` with body `{ "eventType": "BANK_ACCOUNT_CHANGE", "payload": { "employeeId": …, "effectiveDate": …, "iban": … } }`, an `Idempotency-Key` header, and the access token, display the returned `{ id, status }`, and add the event to the tracked list

#### Scenario: Fields are swapped per event type
- **WHEN** the user selects `ADDRESS_CHANGE` and then `SALARY_CHANGE`
- **THEN** the form SHALL render `street`, `city`, `postalCode`, `country` for `ADDRESS_CHANGE` and `newSalary`, `currency` for `SALARY_CHANGE`, with `employeeId` and `effectiveDate` present for both, matching the `event-submission` field contract

#### Scenario: Missing required field is blocked before submitting
- **WHEN** the user attempts to submit with a required field of the selected type left empty
- **THEN** the UI SHALL show a field-level validation message and SHALL NOT send a request

#### Scenario: API validation error is surfaced
- **WHEN** the API responds `400` (for example a malformed IBAN or an unknown field)
- **THEN** the UI SHALL display the structured error message and keep the entered values editable

#### Scenario: Fresh Idempotency-Key per submission
- **WHEN** the user submits two events in sequence
- **THEN** the two requests SHALL carry different `Idempotency-Key` header values

#### Scenario: Submission form is unavailable without a session
- **WHEN** no session is active
- **THEN** the UI SHALL present the sign-in/registration step instead of the submission form and SHALL NOT allow a submission to be sent

## ADDED Requirements

### Requirement: The UI authenticates against the API and keeps the session usable
The system SHALL present a sign-in step before the event views, offering both sign-in for an existing account and registration of a new organization and owner. On success the UI SHALL retain the returned access token and refresh token so the session survives a page reload. Every subsequent API request SHALL carry the access token. When a request fails with HTTP `401` because the access token expired, the UI SHALL attempt a single refresh using the stored refresh token and retry the request; if the refresh fails, the UI SHALL discard the session, return to the sign-in step, and discard any tenant data held in the browser. Signing out SHALL revoke the refresh token through the API and clear the retained session.

#### Scenario: Sign-in unlocks the event views
- **WHEN** a user submits valid credentials on the sign-in step
- **THEN** the UI SHALL show the event submission and tracking views, and requests SHALL carry the returned access token

#### Scenario: Registration creates an organization and signs in
- **WHEN** a user registers with an email, password, a name, and an organization name
- **THEN** the UI SHALL sign them in with the returned session and show the organization they are acting in

#### Scenario: Session survives a reload
- **WHEN** the page is reloaded while a session is retained
- **THEN** the UI SHALL restore the session and SHALL NOT require the user to sign in again

#### Scenario: Expired access token is refreshed transparently
- **WHEN** an API request fails with HTTP `401` and a usable refresh token is retained
- **THEN** the UI SHALL refresh the session once and retry the request, and the user SHALL NOT be returned to the sign-in step

#### Scenario: Failed refresh clears the session
- **WHEN** a refresh attempt is rejected by the API
- **THEN** the UI SHALL clear the retained session and tracked events, and SHALL show the sign-in step

#### Scenario: Signing out revokes and clears the session
- **WHEN** the user signs out
- **THEN** the UI SHALL call the logout endpoint, clear the retained tokens, and return to the sign-in step

#### Scenario: Tracked events are not shared between sessions
- **WHEN** a session ends and a different account signs in on the same browser
- **THEN** the previously tracked events SHALL NOT be shown, because the UI SHALL only ever display events fetched with the current session's token
