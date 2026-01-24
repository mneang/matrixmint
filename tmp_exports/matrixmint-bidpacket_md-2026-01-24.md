# MatrixMint — Bid-Ready Packet (MD)
_Date: 2026-01-24_

## 1) Executive Snapshot
**Coverage:** 79% — Covered 15 / Partial 3 / Missing 1 (Total 19)  
**Proof:** 100% (20/20)

## 2) Proposal Executive Summary (Draft)
MatrixMint Solutions proposes ReliefRoster to empower RapidRelief Network with a scalable, bilingual volunteer coordination platform. Our solution streamlines registration and scheduling while providing the robust reporting and audit logs necessary for nonprofit accountability.

## 3) Compliance Highlights (Non-Covered / Risk Areas)
- **FR-05** (Partial): The system shall support optional SMS reminders (if enabled by the organization).
- **FR-12** (Partial): The system shall allow coordinators to broadcast announcements to selected volunteer segments (by skill/language/location).
- **FR-15** (Partial): The system shall provide accessibility considerations for web UI (keyboard navigation and readable contrast).
- **NFR-03** (Missing): The platform shall provide basic error handling and clear user guidance.

## 4) Clarifications & Questions Log
- **FR-05** — Which third-party SMS providers are currently supported?
- **FR-05** — Are there additional integration fees from MatrixMint?
- **FR-12** — Can 'location' be added as a custom field for segmentation?
- **FR-12** — Is location-based filtering on the product roadmap?
- **FR-15** — Does the UI meet WCAG 2.1 AA contrast requirements?
- **FR-15** — Are there high-contrast themes available?
- **NFR-03** — Does the system provide inline validation errors?
- **NFR-03** — Is there a help center or tooltips for user guidance?

## 5) Risk Register
- **Medium** — Third-party dependency _(Req: FR-05)_
- **Low** — Functional gap _(Req: FR-12)_
- **Medium** — Ambiguity _(Req: FR-15)_
- **Medium** — Ambiguity _(Req: NFR-03)_

## 6) 30 / 60 / 90 Day Plan (Derived from Next Actions)
### Days 0–30
- Confirm supported third-party SMS providers and integration requirements.
- Verify if 'location' can be configured as a custom field for segmentation.

### Days 31–60
- Conduct a contrast ratio audit of the ReliefRoster user interface.
- Request detailed documentation on system error handling and help features.

### Days 61–90
- —

## 7) RFP Response Section Skeleton
1. 1. Summary of Solution
2. 2. Compliance Matrix
3. 3. Implementation Plan (30/60/90 Days)
4. 4. Pricing Approach
5. 5. Risks and Mitigations
6. 6. Support and Training Approach

## 8) Proof Appendix (Requirement → Evidence)
| Requirement | Evidence ID | Evidence Quote |
|---|---|---|
| FR-01 | CB-01 | ReliefRoster provides web-based volunteer registration with configurable form fields and required/optional validation. |
| FR-02 | CB-02 | Coordinators can create events and define shifts with capacity limits |
| FR-03 | CB-02 | volunteers can self-signup for available shifts |
| FR-03 | CB-03 | Automated email confirmations and reminders are supported |
| FR-04 | CB-03 | reminders are supported with configurable schedules (e.g., 24h, 2h) |
| FR-05 | CB-14 | SMS reminders are not included by default; integration is possible via a third-party SMS provider |
| FR-06 | CB-04 | Attendance tracking is supported for each shift, including notes and no-show marking. |
| FR-07 | CB-05 | Volunteer profiles support skills, language preference, certifications, and availability notes. |
| FR-08 | CB-06 | Role-based access is supported with Admin, Coordinator, and Volunteer roles. |
| FR-09 | CB-07 | Messaging templates can be authored in English and Spanish; coordinators can choose the template language per send. |
| FR-10 | CB-08 | Dashboards include volunteer counts, fill rates, attendance rate, and volunteer hours by event. |
| FR-11 | CB-09 | CSV export is supported for rosters, schedules, and attendance logs. |
| FR-12 | CB-10 | broadcast announcements to volunteer segments (by skill and language preference) |
| FR-13 | CB-11 | Coordinator actions are recorded in an audit log (event creation/editing and message sends). |
| FR-14 | CB-12 | Data retention rules can be configured for inactive volunteers (organization chooses retention period). |
| FR-15 | CB-13 | includes keyboard navigation for key workflows |
| NFR-01 | CB-01 | ReliefRoster provides web-based volunteer registration |
| NFR-01 | CB-13 | UI supports mobile browsers |
| NFR-02 | CB-15 | designed for organizations up to ~5,000 volunteers on standard deployment. |
| NFR-04 | CB-09 | CSV export is supported |

