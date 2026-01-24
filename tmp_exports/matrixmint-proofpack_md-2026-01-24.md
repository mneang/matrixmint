# MatrixMint — Compliance Proof Pack

## Summary
- **Date:** 2026-01-24
- **Coverage:** 79%
- **Total:** 19
- **Covered:** 15
- **Partial:** 3
- **Missing:** 1
- **Proof:** 100% (20/20)
- **Proof Notes:**
  - All 15 capability brief statements were successfully mapped to the RFP requirements.
  - ReliefRoster exceeds the volunteer capacity requirement by 150%.
  - Core functional requirements for registration, scheduling, and reporting are fully covered.
  - Proof verifier checks evidenceQuotes against the Capability Brief text (normalized matching; ellipsis wildcard supported).
  - The "Evidence mismatch" flag is verifier-owned and is only added/removed by the proof verifier.
  - Proof totals count unpaired evidence IDs (IDs without quotes) as unverified references (conservative scoring).

## Top Risks
- Third-party dependency for SMS functionality (FR-05).
- Functional gap in location-based volunteer segmentation (FR-12).
- Unverified compliance with accessibility contrast standards (FR-15).
- Lack of documented error handling and user guidance (NFR-03).

## Next Actions
- Confirm supported third-party SMS providers and integration requirements.
- Verify if 'location' can be configured as a custom field for segmentation.
- Conduct a contrast ratio audit of the ReliefRoster user interface.
- Request detailed documentation on system error handling and help features.

## Compliance Matrix
| ID | Category | Status | Requirement | Response Summary | Evidence IDs | Gaps / Questions | Risk Flags |
|---|---|---|---|---|---|---|---|
| FR-01 | Functional | Covered | The system shall support volunteer registration with configurable form fields. | ReliefRoster provides a web-based registration system that allows for configurable form fields. It includes support for both required and optional field validation. | CB-01 | — | — |
| FR-02 | Functional | Covered | The system shall allow coordinators to create events and define shifts with capacity limits. | Coordinators have the ability to manage events and specific shifts. Each shift can be configured with specific capacity limits to manage volunteer flow. | CB-02 | — | — |
| FR-03 | Functional | Covered | The system shall allow volunteers to sign up for shifts and receive confirmations. | Volunteers can self-enroll in available shifts through the platform. The system automatically generates email confirmations upon successful signup. | CB-02, CB-03 | — | — |
| FR-04 | Functional | Covered | The system shall send automated reminders 24 hours and 2 hours before a shift via email. | The platform supports automated email reminders with flexible scheduling. This includes the specific 24-hour and 2-hour intervals requested. | CB-03 | — | — |
| FR-05 | Functional | Partial | The system shall support optional SMS reminders (if enabled by the organization). | SMS reminders are available but are not a native default feature. Integration requires a third-party SMS provider account managed by the organization. | CB-14 | Which third-party SMS providers are currently supported?<br/>Are there additional integration fees from MatrixMint? | Third-party dependency |
| FR-06 | Functional | Covered | The system shall allow coordinators to mark attendance and record no-shows. | ReliefRoster includes dedicated attendance tracking features. Coordinators can record attendance, add notes, and specifically flag no-shows. | CB-04 | — | — |
| FR-07 | Functional | Covered | The system shall maintain a volunteer profile including languages, skills, certifications, and availability. | Comprehensive volunteer profiles are supported. These profiles track skills, language preferences, certifications, and availability notes. | CB-05 | — | — |
| FR-08 | Functional | Covered | The system shall support role-based access (Admin, Coordinator, Volunteer). | The platform utilizes role-based access control. It includes the specific roles of Admin, Coordinator, and Volunteer as required. | CB-06 | — | — |
| FR-09 | Functional | Covered | The system shall provide a bilingual messaging option (English/Spanish) for templates. | Messaging templates can be created in both English and Spanish. Coordinators can select the appropriate language template for each communication. | CB-07 | — | — |
| FR-10 | Functional | Covered | The system shall provide a dashboard showing: total registered volunteers, upcoming shifts and fill rates, attendance rate and no-show rate, volunteer hours by event. | The system includes a dashboard that tracks all requested metrics. This includes volunteer counts, fill rates, attendance percentages, and total hours. | CB-08 | — | — |
| FR-11 | Functional | Covered | The system shall support CSV export of volunteer rosters, schedules, and attendance logs. | ReliefRoster supports data portability via CSV export. This functionality covers rosters, schedules, and attendance logs. | CB-09 | — | — |
| FR-12 | Functional | Partial | The system shall allow coordinators to broadcast announcements to selected volunteer segments (by skill/language/location). | The system supports broadcasting to segments based on skill and language. However, location-based segmentation is not explicitly mentioned in the current capabilities. | CB-10 | Can 'location' be added as a custom field for segmentation?<br/>Is location-based filtering on the product roadmap? | Functional gap |
| FR-13 | Functional | Covered | The system shall provide a basic audit log of coordinator actions (event created, shift edited, message sent). | An audit log records key coordinator activities. This includes event creation, edits, and communication history. | CB-11 | — | — |
| FR-14 | Functional | Covered | The system shall support data retention settings (e.g., delete inactive volunteer records after X months). | The platform allows organizations to define their own data retention rules. This includes automated handling of inactive volunteer records. | CB-12 | — | — |
| FR-15 | Functional | Partial | The system shall provide accessibility considerations for web UI (keyboard navigation and readable contrast). | The UI supports keyboard navigation for essential workflows. However, specific documentation regarding readable contrast standards is currently missing. | CB-13 | Does the UI meet WCAG 2.1 AA contrast requirements?<br/>Are there high-contrast themes available? | Ambiguity |
| NFR-01 | NonFunctional | Covered | The platform shall be accessible via modern browsers on desktop and mobile. | ReliefRoster is a web-based platform designed for modern browsers. It includes specific support for mobile browser access. | CB-01, CB-13 | — | — |
| NFR-02 | NonFunctional | Covered | The platform shall support at least 2,000 registered volunteers. | The standard deployment of ReliefRoster supports up to 5,000 registered volunteers, exceeding the requirement. | CB-15 | — | — |
| NFR-03 | NonFunctional | Missing | The platform shall provide basic error handling and clear user guidance. | The capability brief does not explicitly detail error handling mechanisms or user guidance features. | — | Does the system provide inline validation errors?<br/>Is there a help center or tooltips for user guidance? | Ambiguity |
| NFR-04 | NonFunctional | Covered | The platform shall ensure that exported data can be downloaded without additional tools. | Data is exported in CSV format, which is a standard file type that does not require proprietary tools to open or download. | CB-09 | — | — |

