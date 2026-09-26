# TaskFlow Discord Bot
## Development Specification & Technology Recommendation

> **Core idea:** TaskFlow is not merely a reminder bot. It is a **Task OS inside Discord** that helps users capture tasks, plan work, receive smart reminders, focus, complete tasks, and review productivity.

---

# 1. Recommended Technology Stack

## Main language: TypeScript

For the complete product, **TypeScript is the recommended primary language**.

The reason is that nearly every major component can stay in one ecosystem:

```text
Discord Bot
    ↓
TypeScript / Node.js
    ├── Discord.js
    ├── REST/API
    ├── Task Engine
    ├── AI Integration
    ├── Scheduler / Worker
    ├── PostgreSQL ORM
    └── Web Dashboard later
```

This avoids creating a Python + Node.js system too early.

### Why TypeScript?

| Requirement | TypeScript |
|---|---|
| Discord Bot | Excellent |
| Discord buttons / menus / modals | Excellent |
| Slash commands | Excellent |
| AI API integration | Excellent |
| PostgreSQL | Excellent |
| Background jobs | Excellent |
| Redis / queues | Excellent |
| Web dashboard | Excellent |
| Type safety | Excellent |
| Large project maintainability | Excellent |
| Docker deployment | Excellent |
| Real-time systems | Excellent |
| Team collaboration | Excellent |

### Recommended runtime

Use:

```text
Node.js 24 LTS
TypeScript
```

Node.js 24 is currently an LTS line; the Node.js project recommends using Active LTS or Maintenance LTS releases for production applications.

Source:
https://nodejs.org/en/about/previous-releases

---

# 2. Main Framework and Libraries

## Discord

Use:

```text
discord.js
```

Recommended responsibilities:

- Slash commands
- Buttons
- Select menus
- Modals
- Context menu commands
- Message events
- Attachments
- Threads
- DM notifications
- Role/member management
- Interaction handling

---

## Database

Use:

```text
PostgreSQL
```

Why PostgreSQL?

TaskFlow will eventually contain relationships such as:

```text
User
 ├── Tasks
 ├── Projects
 ├── Courses
 ├── Reminders
 ├── Focus Sessions
 └── Activity Logs

Project
 ├── Members
 └── Tasks

Task
 ├── Subtasks
 ├── Dependencies
 ├── Reminders
 └── Attachments
```

This is strongly relational data, so PostgreSQL is a natural fit.

---

## ORM

Recommended:

```text
Prisma ORM
```

Prisma provides type-safe database access for TypeScript and supports PostgreSQL.

Current Prisma documentation:
https://www.prisma.io/docs/prisma-orm/quickstart/postgresql

---

# 3. Background Jobs / Reminder Engine

Do **not** rely on `setTimeout()` for production reminders.

Bad approach:

```text
Bot
 └── setTimeout()
       └── reminder
```

Problems:

- process restart can lose timers
- multiple bot instances become difficult to manage
- persistent scheduling is harder
- retries are difficult
- monitoring is poor

Use:

```text
Redis
+
BullMQ
```

Architecture:

```text
Task Created
     │
     ▼
Reminder Service
     │
     ▼
BullMQ Queue
     │
     ▼
Redis
     │
     ▼
Worker
     │
     ▼
Discord Notification
```

BullMQ is TypeScript-based and uses Redis-backed queues with workers and delayed jobs.

Source:
https://docs.bullmq.io/quick-start

---

# 4. AI Layer

Use an LLM API as an **intelligence layer**, not as the whole application.

AI responsibilities:

```text
Natural language parsing
Task extraction
Deadline extraction
Priority classification
Task breakdown
Daily planning
Weekly summaries
Rescheduling suggestions
Message → task extraction
Attachment → task extraction
```

Example:

```text
User:
"Besok jam 8 malam jangan lupa bikin laporan PLC."

                ↓

               AI

                ↓

{
  "title": "Bikin laporan PLC",
  "dueAt": "...",
  "estimatedMinutes": null,
  "priority": "MEDIUM"
}

                ↓

         Task Service

                ↓

          PostgreSQL
```

The application itself remains responsible for:

- validation
- permissions
- database writes
- scheduling
- reminder delivery
- business rules

Do not let AI directly perform arbitrary database operations.

---

# 5. Why Not Make It Fully Python?

Python is excellent for:

- Machine learning
- Data science
- NLP experimentation
- Custom ML models
- Computer vision

But for this particular product, using Python for the entire application would mean giving up some of the advantages of having one consistent TypeScript ecosystem for:

```text
Discord
Backend
Worker
Database
Dashboard
Types
Validation
Testing
Deployment
```

### Recommended strategy

```text
V1–V3:
100% TypeScript

Later:
TypeScript
   │
   ├── Main application
   └── Optional Python AI/ML service
```

Only introduce Python when there is an actual ML workload that benefits from it.

---

# 6. Overall Architecture

```text
                              DISCORD
                                 │
                                 ▼
                         ┌──────────────┐
                         │ Discord Bot  │
                         │   discord.js │
                         └──────┬───────┘
                                │
                     ┌──────────┼──────────┐
                     ▼          ▼          ▼
               Task Service  AI Service  Project Service
                     │          │          │
                     └──────────┼──────────┘
                                ▼
                         PostgreSQL
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
                Redis                    Analytics
                    │
                    ▼
                 BullMQ
                    │
                    ▼
                  Worker
                    │
                    ▼
              Notification
                 Engine
                    │
                    ▼
             Discord DM/Channel
```

---

# 7. Product Architecture

Split the application by responsibility.

```text
src/
├── bot/
│   ├── commands/
│   ├── interactions/
│   ├── events/
│   └── components/
│
├── modules/
│   ├── task/
│   ├── reminder/
│   ├── project/
│   ├── course/
│   ├── inbox/
│   ├── focus/
│   ├── analytics/
│   ├── ai/
│   ├── user/
│   └── notification/
│
├── workers/
│   ├── reminder.worker.ts
│   ├── recurring.worker.ts
│   ├── analytics.worker.ts
│   └── ai.worker.ts
│
├── database/
│   ├── prisma/
│   └── seed/
│
├── shared/
│   ├── types/
│   ├── constants/
│   ├── validators/
│   ├── errors/
│   └── utils/
│
├── config/
│   └── env.ts
│
└── index.ts
```

---

# 8. Core Product Modules

The first architecture should contain these modules:

```text
1. User
2. Task
3. Inbox
4. Reminder
5. Project
6. Course
7. Focus
8. AI
9. Notification
10. Analytics
11. Settings
```

---

# 9. Task Model

Every task should have a standard structure.

Example:

```ts
Task {
  id
  userId
  projectId?
  courseId?

  title
  description?

  status
  priority

  startAt?
  dueAt?

  estimatedMinutes?
  actualMinutes?

  recurringRule?

  sourceType?
  sourceMessageId?
  sourceChannelId?

  createdAt
  updatedAt
  completedAt?
}
```

---

# 10. Task Status

Recommended statuses:

```text
TODO
IN_PROGRESS
WAITING
BLOCKED
DONE
OVERDUE
CANCELLED
```

Visual mapping:

```text
⚪ TODO
🔵 IN_PROGRESS
🟡 WAITING
🟣 BLOCKED
🟢 DONE
🔴 OVERDUE
⚫ CANCELLED
```

---

# 11. Priority

Use:

```text
LOW
MEDIUM
HIGH
URGENT
```

The user can manually set priority.

AI can suggest priority but should not silently override an explicit user choice.

---

# 12. Task Inbox

The inbox is one of the main product differentiators.

Users can dump raw thoughts:

```text
📥 INBOX

- Bikin laporan PLC
- baca jurnal AI
- kirim file ke dosen
- belajar regresi
```

The bot then provides:

```text
[Process All]
[Process One by One]
[Delete]
```

AI can convert raw text into structured tasks.

---

# 13. Natural Language Task Creation

User:

```text
Besok jam 7 malam kerjakan laporan PLC selama 2 jam.
```

AI extracts:

```json
{
  "title": "Kerjakan laporan PLC",
  "dueAt": "2026-09-27T19:00:00+07:00",
  "estimatedMinutes": 120
}
```

Application validates the response before saving.

---

# 14. Discord Message → Task

This should be a major feature.

User right-clicks a message:

```text
Apps
  → TaskFlow
      → Create Task
```

Example source message:

```text
Deadline tugas Sistem Pakar:
Senin, 23:59.
```

Bot extracts:

```text
Task:
Tugas Sistem Pakar

Deadline:
Monday 23:59

Source:
#kelas-sistem-pakar
```

Store the source message ID so the task can remain traceable.

---

# 15. Attachment → Task

User uploads:

```text
Tugas_AI.pdf
```

Then:

```text
TaskFlow
   ↓
Read supported content
   ↓
AI extraction
   ↓
Detected tasks
```

Example:

```text
🤖 I found 6 possible tasks.

1. Literature review
2. Define variables
3. Create methodology
4. Collect data
5. Analyze results
6. Prepare presentation

[Create All]
[Review]
[Cancel]
```

---

# 16. Voice → Task

Optional advanced feature.

User sends a voice message:

> "Besok pagi jangan lupa bikin laporan PLC."

Pipeline:

```text
Voice Message
      ↓
Speech-to-Text
      ↓
LLM parsing
      ↓
Task object
      ↓
User confirmation
```

This should be implemented after the core task/reminder system is stable.

---

# 17. Smart Reminder Engine

Reminder logic should consider:

```text
deadline
estimated duration
priority
task size
user preferences
quiet hours
previous postponements
```

Example:

```text
Task:
Build IoT dashboard

Deadline:
Friday 23:59

Estimated:
6 hours

Priority:
HIGH
```

Possible reminders:

```text
H-3 days
H-1 day
H-6 hours
H-1 hour
H-15 minutes
```

The user should be able to customize the reminder profile.

---

# 18. Reminder Profiles

Create profiles:

```text
LIGHT
NORMAL
IMPORTANT
URGENT
CUSTOM
```

Example:

```text
LIGHT
└── H-1 day

NORMAL
├── H-1 day
└── H-1 hour

IMPORTANT
├── H-3 days
├── H-1 day
├── H-3 hours
└── H-30 minutes

URGENT
├── H-3 days
├── H-1 day
├── H-6 hours
├── H-1 hour
└── H-15 minutes
```

---

# 19. Quiet Hours

Each user has:

```text
timezone
quietStart
quietEnd
```

Example:

```text
Timezone:
Asia/Jakarta

Quiet hours:
23:00–07:00
```

Reminder engine should respect this unless the user explicitly enables critical reminders.

---

# 20. Snooze

Buttons:

```text
[30m]
[1h]
[Tonight]
[Tomorrow]
[Custom]
```

The bot recalculates the reminder schedule after snooze.

Do not simply create duplicate reminders.

---

# 21. Smart Rescheduling

This is one of the strongest advanced features.

Example:

```text
Task:
Laporan IoT

Original:
Today 20:00
```

User repeatedly postpones.

Bot detects:

```text
Postponed: 3 times
Estimated: 2 hours
Remaining time: 1 hour
```

It can suggest:

```text
⚠️ This task has been postponed several times.

Possible actions:

[Break Down]
[Move to Tomorrow]
[Set Focus Session]
[Edit Estimate]
```

---

# 22. Task Breakdown

AI should break large tasks into actionable steps.

Input:

```text
Bikin skripsi AI
```

Output:

```text
1. Search literature
2. Define research problem
3. Define variables
4. Write methodology
5. Collect data
6. Analyze data
7. Write discussion
8. Write conclusion
9. Prepare slides
10. Practice presentation
```

Each subtask can become a first-class task or remain nested depending on user preference.

---

# 23. Task Dependency

Tasks can depend on other tasks.

Example:

```text
Search papers
      ↓
Review papers
      ↓
Write chapter 2
```

If:

```text
Review papers = NOT DONE
```

then:

```text
Write chapter 2 = BLOCKED
```

This allows more intelligent planning.

---

# 24. Focus Mode

User:

```text
/focus
```

Bot:

```text
🎯 FOCUS SESSION

Task:
Laporan IoT

Estimated:
2 hours

[Start 25m]
[Start 50m]
[Custom]
```

Track:

```text
startedAt
endedAt
duration
interruptions
taskId
```

---

# 25. Productivity Analytics

Track:

```text
completed tasks
overdue tasks
average completion time
estimated vs actual time
postponements
focus sessions
streaks
```

Example:

```text
📊 WEEKLY REVIEW

Completed: 23
Overdue: 2
Postponed: 5

Estimated:
18h

Actual:
22h

Accuracy:
82%
```

---

# 26. Personal Planning

AI can generate a daily plan.

Input:

```text
Available time:
19:00–23:00

Tasks:
- Laporan IoT — 2h
- Jurnal AI — 1h
- Regression — 2h
```

Output:

```text
19:00–21:00
Laporan IoT

21:00–22:00
Jurnal AI

22:00–23:00
Regression — Part 1
```

Remaining work is automatically scheduled for another day.

---

# 27. Workload Detection

If the user's tasks exceed available time:

```text
⚠️ DAILY LOAD

Estimated workload:
9h 30m

Available:
5h

Overload:
4h 30m
```

Possible actions:

```text
[Auto Plan]
[Move Low Priority]
[Keep Schedule]
```

The system should suggest rather than silently changing deadlines.

---

# 28. Project Mode

Command:

```text
/project create IoT Smart Farm
```

Project:

```text
📦 IoT Smart Farm

Progress:
███████░░░ 72%

Members:
@Naufal
@Raka
@Dimas

Tasks:
✅ Sensors
✅ Backend
🔵 Dashboard
⚪ Documentation
```

---

# 29. Team Tasks

A task can contain:

```text
assignee
reviewer
priority
deadline
status
attachments
comments
```

Only authorized members should be able to modify team tasks.

---

# 30. Course Mode

For student-oriented deployments:

```text
📚 COURSES

IoT
AI
Sistem Pakar
Regresi
Metodologi Penelitian
```

Every task may be linked to a course.

Example:

```text
Task:
Makalah AI

Course:
AI

Deadline:
30 Sep

Estimated:
3h
```

---

# 31. Deadline Radar

Main command:

```text
/today
```

Example:

```text
🚨 DEADLINE RADAR

TODAY

🔴 Laporan IoT
23:59

🟠 Jurnal AI
21:00

TOMORROW

🟡 Sistem Pakar
23:59

THIS WEEK

🟢 Regresi
30 Sep
```

---

# 32. Daily Briefing

At a configurable time:

```text
☀️ GOOD MORNING

TODAY

🔴 Laporan IoT
23:59

🟡 Jurnal AI
21:00

Estimated workload:
4h 30m

Available:
6h

Status:
🟢 Manageable

[Start Day]
[View All]
```

---

# 33. Weekly Review

Every week:

```text
📊 WEEKLY REVIEW

Completed:
23

Incomplete:
4

Overdue:
2

Postponed:
5

Focus time:
14h 20m

Estimate accuracy:
82%
```

The bot can summarize:

```text
You completed most high-priority tasks,
but several large tasks were repeatedly postponed.
```

This summary can be AI-generated.

---

# 34. Gamification

Optional.

Track:

```text
XP
Level
Streak
Achievements
```

Examples:

```text
🔥 7 Day Streak
✅ 50 Tasks Completed
⏱️ 10 Hours Focus
🚀 Zero Overdue Week
```

Do not make gamification mandatory.

---

# 35. Database Design

Recommended primary entities:

```text
User
Guild
GuildMember
Task
Subtask
TaskDependency
Reminder
Project
ProjectMember
Course
FocusSession
Attachment
ActivityLog
Notification
UserSettings
```

Relationship example:

```text
User
 │
 ├── Tasks
 │    ├── Subtasks
 │    ├── Reminders
 │    ├── Dependencies
 │    └── Attachments
 │
 ├── Projects
 │
 ├── Courses
 │
 ├── FocusSessions
 │
 └── Settings
```

---

# 36. Suggested PostgreSQL Tables

## users

```text
id
discord_id
username
timezone
created_at
updated_at
```

## guilds

```text
id
discord_guild_id
name
created_at
```

## tasks

```text
id
user_id
guild_id
project_id
course_id

title
description

status
priority

start_at
due_at

estimated_minutes
actual_minutes

source_type
source_message_id
source_channel_id

recurring_rule

created_at
updated_at
completed_at
```

## subtasks

```text
id
task_id
title
status
position
created_at
completed_at
```

## reminders

```text
id
task_id
user_id

reminder_at
status

delivery_type
delivery_channel_id

sent_at
created_at
```

## task_dependencies

```text
task_id
depends_on_task_id
dependency_type
```

## focus_sessions

```text
id
task_id
user_id

started_at
ended_at
duration_minutes
interruptions
```

## activity_logs

```text
id
user_id
task_id

event_type
metadata
created_at
```

---

# 37. Redis Usage

Redis should not become the permanent source of truth.

Use PostgreSQL as the source of truth.

Use Redis for:

```text
BullMQ jobs
temporary locks
rate limiting
short-lived cache
worker coordination
```

Architecture:

```text
PostgreSQL = Source of Truth

Redis = Speed + Queue
```

---

# 38. API / Service Boundaries

Even if the first version is a single process, design modules cleanly.

Example:

```text
TaskService
ReminderService
AIService
ProjectService
AnalyticsService
NotificationService
```

Example:

```ts
await taskService.createTask(...)
await reminderService.scheduleForTask(...)
await notificationService.send(...)
```

Avoid putting all logic directly inside Discord command handlers.

Bad:

```ts
interactionCreate(...)
    -> database
    -> AI
    -> scheduling
    -> notification
```

Better:

```text
Discord Handler
      ↓
TaskService
      ↓
Repository
      ↓
Database
```

---

# 39. Command Design

Keep the command set small.

Recommended:

```text
/task
/tasks
/inbox
/today
/week
/project
/focus
/stats
/review
/settings
```

Use buttons, select menus, and modals for detailed interaction.

---

# 40. Context Menu Commands

Highly recommended:

```text
Right-click message
    ↓
TaskFlow
    ├── Create Task
    ├── Remind Me
    └── Add to Inbox
```

This makes TaskFlow feel native to Discord.

---

# 41. Security

Never expose:

```text
DATABASE_URL
BOT_TOKEN
AI_API_KEY
REDIS_URL
```

Use:

```text
.env
```

and environment variables in deployment.

Validate:

- Discord user ID
- Guild permissions
- Project membership
- Task ownership
- Input length
- Date/time validity
- AI output schema

AI output must always go through validation.

---

# 42. AI Safety / Reliability

Never trust model output blindly.

Pipeline:

```text
User Input
   ↓
LLM
   ↓
Structured JSON
   ↓
Schema Validation
   ↓
Business Rules
   ↓
Database
```

Recommended validation library:

```text
Zod
```

Example:

```ts
const TaskExtractionSchema = z.object({
  title: z.string().min(1).max(200),
  dueAt: z.string().datetime().nullable(),
  estimatedMinutes: z.number().int().positive().nullable(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"])
});
```

---

# 43. Timezone Handling

This is critical for a reminder bot.

Never assume all users are UTC.

Store:

```text
Asia/Jakarta
Asia/Tokyo
Europe/London
America/New_York
```

Use timezone-aware timestamps.

Store timestamps in UTC internally where appropriate, then render them according to the user's timezone.

Example:

```text
Database:
2026-09-27T12:00:00Z

User timezone:
Asia/Jakarta

Display:
27 September 2026 — 19:00
```

---

# 44. Recurring Tasks

Do not create thousands of future database rows unnecessarily.

Store a recurrence rule:

```text
FREQ=WEEKLY;BYDAY=MO,WE,FR
```

Then the worker creates or schedules the next occurrence.

---

# 45. Reminder Worker

Concept:

```text
Worker receives job
        ↓
Load reminder
        ↓
Check status
        ↓
Check user preferences
        ↓
Check task status
        ↓
Send notification
        ↓
Mark reminder as sent
        ↓
Create activity log
```

If sending fails:

```text
Retry
  ↓
Retry
  ↓
Dead Letter / Failed Job
```

---

# 46. Notification Types

Support:

```text
DM
Channel message
Thread message
Ephemeral interaction response
```

Default:

```text
DM for personal tasks
Channel for team/project tasks
```

---

# 47. Notification Throttling

Avoid notification spam.

Example:

```text
Maximum:
3 task reminders/hour
```

unless user explicitly configures a different policy.

Group notifications where possible:

```text
🔔 3 TASKS TODAY

• AI Journal — 19:00
• PLC Report — 21:00
• Regression — 23:59
```

---

# 48. Testing Strategy

Use:

```text
Vitest
```

Test:

### Unit

```text
date parsing
reminder calculation
priority logic
workload calculation
recurring rules
```

### Integration

```text
Task → PostgreSQL
Task → Reminder Queue
Worker → Notification
```

### End-to-end

```text
Discord command
→ task creation
→ reminder scheduling
→ completion
```

---

# 49. Observability

Track:

```text
command latency
AI latency
AI failures
queue latency
worker failures
database errors
notification failures
```

Use structured logs.

Example:

```json
{
  "event": "reminder.sent",
  "taskId": "abc123",
  "userId": "discord-user",
  "latencyMs": 120
}
```

---

# 50. Deployment

Recommended:

```text
Docker
  │
  ├── bot
  ├── worker
  └── migration/utility
```

External services:

```text
PostgreSQL
Redis
```

Possible deployment architecture:

```text
                 Internet
                    │
                    ▼
              Discord API
                    │
                    ▼
              TaskFlow Bot
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
   PostgreSQL                  Redis
                                │
                                ▼
                           BullMQ Worker
```

---

# 51. Development Environment

Recommended tools:

```text
Node.js 24 LTS
TypeScript
pnpm
Docker
PostgreSQL
Redis
VS Code
Git
GitHub
```

Optional:

```text
Prisma Studio
```

---

# 52. Package Concept

Possible packages:

```text
discord.js
typescript
zod
prisma
@prisma/client
bullmq
ioredis
dotenv
date-fns
date-fns-tz
pino
vitest
```

Add the official OpenAI JavaScript/TypeScript SDK if using OpenAI for the AI layer.

Pin production dependencies deliberately and review library versions before deployment.

---

# 53. Project Structure

```text
taskflow/
│
├── src/
│   ├── bot/
│   │   ├── commands/
│   │   ├── events/
│   │   ├── components/
│   │   └── context-menus/
│   │
│   ├── modules/
│   │   ├── task/
│   │   │   ├── task.service.ts
│   │   │   ├── task.repository.ts
│   │   │   ├── task.schema.ts
│   │   │   └── task.types.ts
│   │   │
│   │   ├── reminder/
│   │   ├── ai/
│   │   ├── project/
│   │   ├── course/
│   │   ├── focus/
│   │   ├── analytics/
│   │   ├── notification/
│   │   └── user/
│   │
│   ├── workers/
│   │   ├── reminder.worker.ts
│   │   ├── recurring.worker.ts
│   │   └── analytics.worker.ts
│   │
│   ├── config/
│   ├── database/
│   ├── shared/
│   └── index.ts
│
├── prisma/
│   ├── schema.prisma
│   └── seed.ts
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
│
├── docker-compose.yml
├── Dockerfile
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

---

# 54. Development Roadmap

## Phase 0 — Foundation

Build:

```text
✅ Node.js
✅ TypeScript
✅ Discord.js
✅ PostgreSQL
✅ Prisma
✅ Docker
```

Goal:

```text
Bot online
Database connected
Basic command working
```

---

# 55. Phase 1 — MVP

Implement:

```text
✅ /task create
✅ /tasks
✅ /task edit
✅ /task delete
✅ /task done
✅ deadline
✅ status
✅ priority
```

No AI yet.

Reason:

The core data model must work before AI is added.

---

# 56. Phase 2 — Reminder Engine

Implement:

```text
✅ Redis
✅ BullMQ
✅ Reminder worker
✅ DM reminders
✅ Reminder profiles
✅ Snooze
✅ Quiet hours
✅ Timezones
```

At this point the bot already becomes useful.

---

# 57. Phase 3 — Discord-native UX

Implement:

```text
✅ Buttons
✅ Modals
✅ Select menus
✅ Context menu
✅ Message → Task
✅ Task cards
✅ /today
✅ /week
```

The goal is to reduce command typing.

---

# 58. Phase 4 — AI

Implement:

```text
✅ Natural language tasks
✅ AI task extraction
✅ Deadline extraction
✅ Priority suggestion
✅ Task breakdown
✅ AI summaries
```

AI should always require validation before database writes.

---

# 59. Phase 5 — Productivity Intelligence

Implement:

```text
✅ Focus mode
✅ Estimated vs actual time
✅ Workload detection
✅ Smart rescheduling
✅ Daily planning
✅ Weekly review
```

---

# 60. Phase 6 — Collaboration

Implement:

```text
✅ Projects
✅ Members
✅ Roles
✅ Shared tasks
✅ Dependencies
✅ Team dashboard
✅ Activity log
```

---

# 61. Phase 7 — Advanced Integrations

Implement:

```text
✅ Google Calendar
✅ Voice → task
✅ Attachment → task
✅ Web dashboard
✅ Mobile-friendly web UI
```

---

# 62. First Release Scope

Do not include every idea in v1.

Recommended v1:

```text
CORE
├── Task CRUD
├── Deadline
├── Status
├── Priority
│
REMINDER
├── Scheduled reminders
├── Snooze
├── DM notification
└── Timezone
│
DISCORD UX
├── Buttons
├── Modals
└── Message → Task
```

That is enough for the first useful release.

---

# 63. v2 Scope

```text
AI
├── Natural language
├── Task extraction
└── Task breakdown

PRODUCTIVITY
├── Daily briefing
├── Focus mode
├── Weekly review
└── Statistics
```

---

# 64. v3 Scope

```text
COLLABORATION
├── Projects
├── Team tasks
├── Dependencies
└── Activity logs

INTEGRATION
├── Google Calendar
└── File/voice processing
```

---

# 65. Product Differentiation

TaskFlow's strongest identity should be:

```text
Discord Message
       ↓
      AI
       ↓
   Create Task
       ↓
     Plan
       ↓
   Reminder
       ↓
    Focus
       ↓
   Complete
       ↓
    Review
```

Therefore the product is:

> **A productivity system embedded inside Discord.**

Not:

> A Discord bot that sends alarms.

---

# 66. Recommended Final Stack

```text
LANGUAGE
TypeScript

RUNTIME
Node.js 24 LTS

DISCORD
discord.js

DATABASE
PostgreSQL

ORM
Prisma ORM

QUEUE
BullMQ

CACHE
Redis

VALIDATION
Zod

AI
OpenAI API / another LLM API

DATE/TIME
date-fns + timezone support

LOGGING
Pino

TESTING
Vitest

CONTAINER
Docker

PACKAGE MANAGER
pnpm

SOURCE CONTROL
Git + GitHub
```

---

# 67. Final Recommendation

For this particular project, **use TypeScript as the main language from the beginning**.

The recommended architecture is:

```text
TypeScript
    │
    ├── Discord.js
    │
    ├── Task / Project / Course Services
    │
    ├── Prisma
    │      ↓
    │   PostgreSQL
    │
    ├── BullMQ
    │      ↓
    │    Redis
    │
    ├── AI SDK
    │
    └── Notification Engine
```

Do not start with microservices.

Start with a **modular monolith**:

```text
One repository
One main codebase
Clear modules
One PostgreSQL
One Redis
One bot
One worker
```

When traffic or complexity actually requires separation, then split services.

This approach gives the project:

- simpler development
- easier debugging
- shared TypeScript types
- consistent validation
- simpler deployment
- easier contribution from other developers
- a clear path to scale later

---

# 68. Recommended First Milestone

The first milestone should be:

```text
User:
"Besok jam 8 malam bikin laporan PLC"

        ↓

TaskFlow
        ↓

AI parses input

        ↓

User confirms

        ↓

PostgreSQL stores task

        ↓

BullMQ schedules reminder

        ↓

At reminder time

        ↓

Discord DM

        ↓

[Start]
[Done]
[Snooze]

        ↓

User clicks Done

        ↓

Task becomes DONE

        ↓

Activity log updated
```

Once this flow is reliable, the rest of the platform can be built around it.

---

# 69. Key Engineering Principles

```text
1. PostgreSQL is the source of truth.
2. Redis is for queues/cache, not permanent task storage.
3. AI suggests/extracts; business logic validates.
4. Discord handlers should stay thin.
5. All dates must be timezone-aware.
6. Reminder jobs must be persistent.
7. User actions must be idempotent where possible.
8. Team permissions must be checked server-side.
9. Build modularly before splitting into microservices.
10. Build the core task/reminder loop before advanced AI.
```

---

# 70. Official References

- Node.js release policy:
  https://nodejs.org/en/about/previous-releases

- Prisma ORM + PostgreSQL:
  https://www.prisma.io/docs/prisma-orm/quickstart/postgresql

- Prisma PostgreSQL connector:
  https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/postgresql

- BullMQ quick start:
  https://docs.bullmq.io/quick-start

- BullMQ queues and delayed jobs:
  https://docs.bullmq.io/guide/queues/

---

# TL;DR

**Best overall language: TypeScript.**

Recommended:

```text
TypeScript
+
Node.js 24 LTS
+
discord.js
+
PostgreSQL
+
Prisma
+
Redis
+
BullMQ
+
Zod
+
LLM API
+
Docker
```

Build it first as a **modular monolith**, then scale only when necessary.

The product's core differentiator should be:

> **Capture → AI Understand → Plan → Remind → Focus → Complete → Review**
