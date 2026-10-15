# monorepo-workspace Specification

## Purpose
Defines the repository as a pnpm workspace driven by Turborepo: which directories are deployable applications and which are shared packages, how one package consumes another without reaching across the filesystem, and how a single command runs a task across every package in dependency order with correct caching.

## Requirements

### Requirement: The repository is a pnpm workspace with declared members
The repository SHALL be a pnpm workspace whose root declares the workspace members, and SHALL pin the package manager version it expects to be used. Every directory containing a `package.json` under the declared member globs SHALL be a workspace member. The root package SHALL be private and SHALL NOT contain application source. Exactly one lockfile SHALL exist for the whole workspace.

#### Scenario: Workspace members are resolvable from the root
- **WHEN** dependencies are installed from the repository root with the frozen lockfile
- **THEN** every application and package under the declared member globs SHALL have its dependencies installed, resolved through the single workspace lockfile

#### Scenario: The package manager version is pinned
- **WHEN** a developer or CI installs dependencies
- **THEN** the package manager version declared by the repository SHALL be the one used, and an install with a different major version SHALL be avoidable by reading that declaration rather than by convention

#### Scenario: A single lockfile governs the workspace
- **WHEN** the repository is checked for lockfiles
- **THEN** exactly one lockfile SHALL exist, at the workspace root, and no member package SHALL carry its own

### Requirement: Applications and shared packages are separated by directory
The workspace SHALL separate deployable units from shared libraries: deployable applications SHALL live under `apps/`, and shared libraries and configuration SHALL live under `packages/`. Each application SHALL be independently buildable and independently containerisable, and SHALL depend on shared behaviour only through declared workspace dependencies.

#### Scenario: Applications are the deployable units
- **WHEN** the repository layout is inspected
- **THEN** the HTTP API, the background worker, and the web UI SHALL each be an application under `apps/`, and no shared library SHALL be deployable on its own

#### Scenario: Shared behaviour lives in packages
- **WHEN** two applications use the same behaviour
- **THEN** that behaviour SHALL live in a package under `packages/` and be reached through a workspace dependency, rather than being duplicated or shared by reaching into another application

#### Scenario: An application is built without its siblings
- **WHEN** a single application is built from the workspace root
- **THEN** only that application and its dependencies SHALL be built, and the other applications SHALL NOT be built as a side effect

### Requirement: Cross-package imports go through declared dependencies
A package SHALL expose what it makes available through its manifest's entrypoint declarations, and SHALL be imported by its workspace name. A member SHALL NOT import another member by a relative filesystem path, and a member SHALL NOT import a dependency it does not declare in its own manifest — including one that happens to resolve by being installed for a sibling.

#### Scenario: Imports use the workspace name
- **WHEN** one member imports behaviour from another
- **THEN** the import SHALL use the depended-on member's package name, and the dependency SHALL be declared in the importing member's manifest

#### Scenario: Undeclared dependencies are rejected
- **WHEN** a member imports a third-party module it does not declare, and another member does declare it
- **THEN** the import SHALL fail to resolve rather than silently succeeding because the module was installed for the sibling

#### Scenario: No relative reach across a boundary
- **WHEN** a member's source is inspected
- **THEN** it SHALL NOT contain a relative import that resolves outside its own directory

### Requirement: The workspace exposes a dependency-aware task graph
The repository SHALL define a task graph such that a single command runs a named task across every workspace member that defines it. Tasks that require a member's dependencies to be built first SHALL declare that ordering, and running a task for one member SHALL run the same task for its dependencies. The graph SHALL cover at minimum building, linting, type-checking, unit testing, end-to-end testing, and running a development server.

#### Scenario: One command runs a task across the workspace
- **WHEN** a task is run from the repository root without naming a member
- **THEN** it SHALL execute for every member that defines that task, and the run SHALL report which members were executed

#### Scenario: Build ordering follows dependencies
- **WHEN** the build task runs
- **THEN** a member's dependencies SHALL be built before that member is built, so a build never consumes an artifact that does not exist yet

#### Scenario: A task can be scoped to one member
- **WHEN** a task is run for a named member and its dependencies
- **THEN** only that member and the members it depends on SHALL execute the task

#### Scenario: The task graph is machine-readable
- **WHEN** a developer asks the workspace what a task would run, without executing it
- **THEN** the workspace SHALL report the packages and tasks involved for that command

### Requirement: Task results are cached and the cache is not corrupted by inputs
A task whose inputs have not changed SHALL be served from cache instead of being re-executed, and the cache SHALL be invalidated when a task's inputs, its dependencies' outputs, or a declared environment variable change. Tasks that are non-deterministic by nature — long-running development servers and suites that drive external services — SHALL NOT be cached.

#### Scenario: An unchanged task is restored from cache
- **WHEN** a task is run twice with no change to its inputs
- **THEN** the second run SHALL be served from cache and SHALL NOT re-execute the task

#### Scenario: A change invalidates the cache
- **WHEN** a source file of a member changes and its task is re-run
- **THEN** the task SHALL re-execute for that member and for the members that depend on it

#### Scenario: Declared environment variables are part of the cache key
- **WHEN** a task's behaviour depends on an environment variable and that variable's value changes
- **THEN** the task SHALL NOT be served from a cache recorded under the previous value

#### Scenario: Non-deterministic tasks are never cached
- **WHEN** the development server task or the end-to-end suite task runs
- **THEN** it SHALL NOT be recorded in or served from the cache

### Requirement: Environment configuration resolves independently of the working directory
Configuration files that are read from disk SHALL resolve to the same location no matter which directory a task is invoked from, because the task runner executes each member's task with that member's directory as the working directory. The workspace SHALL therefore resolve such files from a defined workspace root rather than from the process working directory.

#### Scenario: Configuration loads when a task runs from the root
- **WHEN** a task is run for a member from the repository root
- **THEN** that member's configuration file SHALL be found

#### Scenario: Configuration loads when a task runs from the member directory
- **WHEN** the same member's task is run with its own directory as the working directory
- **THEN** the same configuration file SHALL be found, so both invocations behave identically

#### Scenario: A missing configuration file fails loudly
- **WHEN** the expected configuration file cannot be located
- **THEN** the application SHALL fail at startup with an error naming the file it looked for, rather than starting with unset configuration

### Requirement: Shared vocabulary is framework-agnostic and has more than one consumer
Values and shapes that more than one deployable must agree on — the supported event types, queue and idempotency identifiers, and the shapes of processing results and errors — SHALL live in a package that depends on neither the application framework nor a database client, so that a consumer which cannot run the backend stack can still depend on the contract. Such a package SHALL NOT exist with only a single consumer: if exactly one member uses a contract, it belongs to that member.

#### Scenario: The contract package pulls in no framework
- **WHEN** the shared package's dependency list and its transitive runtime imports are inspected
- **THEN** it SHALL NOT depend on the application framework, on a database client, or on a queue client, and importing it SHALL NOT initialise any of them

#### Scenario: Two members consume the same contract
- **WHEN** the shared package is inspected for consumers
- **THEN** at least two workspace members SHALL declare a dependency on it, so the contract is genuinely shared rather than a folder with one reader

#### Scenario: The contract has one definition
- **WHEN** a consumer needs the set of supported event types, or the shape of an error body
- **THEN** it SHALL import the shared definition, and the workspace SHALL NOT contain a second copy maintained by hand
