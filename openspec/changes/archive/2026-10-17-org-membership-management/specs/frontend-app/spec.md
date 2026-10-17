# Spec Delta

## Purpose

Bring the membership lifecycle into the demo UI: current members are visible at a glance, admins
can invite and manage them, and invitees can complete their join from a link — closing the loop
that makes the second member of an organization a real UI flow.

## ADDED Requirements

### Requirement: The UI manages the organization's members and accepts invitations
The web app SHALL offer a members view listing the organization's members (identity, email,
role, joined at) for every signed-in member, and SHALL surface invite, role-change, and remove
actions only when the signed-in role satisfies the API's requirements (role from the stored
session), sending the same structured 403 handling as other gated features. The app SHALL offer
an invitation-acceptance state reached by opening the accept URL: it SHALL collect the initial
password when the invited email has no account (explaining what will be created), collect the
account password for existing accounts, display the returned organization identity after
success, and hand the user to sign-in for that organization. The acceptance route SHALL take the
token from the URL and never expose it in editable fields.

#### Scenario: Signed-in member browses the member list
- **WHEN** any member opens the members view
- **THEN** the members of their organization SHALL be listed with their roles, and no other organization's members SHALL appear

#### Scenario: Management actions are role-gated in the UI
- **WHEN** a signed-in MEMBER opens the members view
- **THEN** invite, role-change, and remove controls SHALL NOT be presented; when a MEMBER somehow invokes them anyway, the API's 403 SHALL surface through the existing error display

#### Scenario: Admin invites from the UI
- **WHEN** a signed-in ADMIN submits the invite form with an email and role
- **THEN** the UI SHALL display the returned accept URL for out-of-band hand-off and include the invitation in the visible list

#### Scenario: Invitee completes acceptance from the link
- **WHEN** the invitee opens the accept URL in the web app and submits the form
- **THEN** the account/membership SHALL be created through the API and the UI SHALL show the organization joined and route to sign-in

#### Scenario: Owner changes a role from the UI
- **WHEN** the OWNER changes a member's role in the members view
- **THEN** the list SHALL reflect the change after the API confirms it
