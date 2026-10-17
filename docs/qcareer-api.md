# QCareer inside QStudy: API contract

All routes below have `/api` prefix, use the existing QStudy bearer session, SQLite database and student/admin roles. No additional service, account or AI key is required. Identifiers are positive integers. All mutation schemas reject unknown fields. Levels are integers 0–5; readiness is coverage of configured requirements, not a hiring probability or certification.

## Public and personal

- `GET /career/config`: `{enabled,title,description,announcement,logo_url,logo_custom,accent:"orange"}`. Logo is the QStudy branding asset `qcareer` (placeholder until uploaded).
- `GET /career/me`: `{profile,summary,skills,directions,recommendations,activity,disclaimer}`.
  - `profile`: `{user_id,name,group_id,group_name,target_direction_id,interests,about,saved_opportunity_ids}`. Interests: string array.
  - `summary`: `{demonstrated_skills,evidence_count,readiness,target_direction_id,target_direction_title}`; readiness is null when no target/requirements.
  - `skills`: `[{id,slug,name,description,category,is_active,level,evidence:[{kind:"test"|"submission",source_id,title,score,level,course_id,module,href,verified_at}]}]`. Skills only use the current student's completed curriculum tests and admin-graded submissions, never week self-checks/personal tests.
  - `directions`: same items as directions endpoint below.
  - `recommendations`: `{mode:"rules",direction_id,direction_title,steps:[{id,title,description,course_id,course_title,module,week_number,work_id,skill_id,skill_name,from_level,to_level,gains:[{skill_id,skill_name,from_level,to_level}],prerequisites,href,test_href,reason}],remaining_gaps:[{skill_id,skill_name,current_level,required_level,gap}],reason,assumptions:[string]}`. At most three steps, prerequisite-aware, hypothetical gains only after successful verification. Multiple skills linked to the same learning selection are grouped in one step. If no target is saved, the closest configured direction is used as an explicitly identified preview; it does not silently save a student goal.
  - `activity`: `{completed_weeks,finished_tests,graded_works}`; week completion is activity, not evidence.
- `PATCH /career/profile`: partial `{target_direction_id:int|null,interests:string[],about:string}`; returns profile. Interests: at most 12 strings of 1–60 characters; about: at most 2000 characters.
  A saved target archived later can remain while the student edits personal text; selecting a new archived target is rejected.
- `GET /career/directions`: `{items:[{id,slug,title,description,category,study_paths,career_paths,is_active,requirements:[{skill_id,skill_name,level,current_level,gap}],readiness,matched_skills,total_requirements}]}`. Paths are string arrays, readiness null without requirements.
- `GET /career/directions/{id}`: one direction including personal coverage.
- `GET /career/opportunities?kind=internship&direction_id=1&saved=true`: `{items:[{id,title,organization,description,kind:"job"|"internship"|"study"|"course",url,location,direction_id,direction_title,published_at,expires_at,is_active,saved,readiness,requirements_met}],as_of,source:"admin_curated"}`. Only active/non-expired records; published records are curated by administrators, no invented/live scraped vacancies.
- `PUT /career/opportunities/{id}/save`: returns `{saved:true}`. `DELETE` same route: `{saved:false}`. Idempotent and personal.

## Administrator

All routes require administrator on the server, changes are written to the existing immutable audit journal.

- `GET/PATCH /admin/career/config`: same config, editable `{enabled,title,description,announcement}`. Logo upload is provided by the existing branding subsystem.
- `GET/POST /admin/career/skills`, `PATCH/DELETE /admin/career/skills/{id}`. List `{items:[Skill]}`. Input `{slug,name,description,category,is_active}` (defaults description/category empty, active true). Delete removes configured mappings/requirements, not student test records.
- `GET/POST /admin/career/directions`, `PATCH/DELETE /admin/career/directions/{id}`. List `{items:[Direction]}`. Input `{slug,title,description,category,study_paths:string[],career_paths:string[],is_active,requirements:[{skill_id,level:1..5}]}`; requirement updates replace the whole list.
- `GET/POST /admin/career/learning-links`, `PATCH/DELETE /admin/career/learning-links/{id}`. List `{items:[LearningLink]}`. Input `{skill_id,course_id,module,week_number:int|null,work_id:int|null,syllabus_id:int|null,title,description,target_level:1..5,min_score:0..100,prerequisites:[{skill_id,level:1..5}],is_active}`. Optional title/description/module empty; source IDs must belong to the selected course and be published. Source filters are intersected; a course-wide test cannot prove a specific module/week/work. Output adds `id,skill_name,course_title,group_id,group_name,href,test_href`.
- `POST /admin/career/learning-links/suggest` with `{}`: `{items:[{course_id,course_title,group_id,group_name,skill_id,skill_name,title,description,module:"",target_level:2,min_score:70,reason}],count}`. Dry run of conservative discipline-title aliases for the initial skill catalog; only courses with published rows, only missing course/skill mappings. No evidence is awarded.
- `POST /admin/career/learning-links/apply-suggestions` with `{course_ids:[id]}`: `{created,items:[LearningLink]}`. Recomputes suggestions on the server, inserts missing mappings for selected courses and records the count in the audit journal. Repeat calls do not duplicate mappings.
- `GET /admin/career/sources`: `{courses:[{id,title,group_id,group_name,modules:string[],weeks:[{id,week_number,title,module,source_syllabus_id}],works:[{id,title,module,week_number,source_syllabus_id}],syllabi:[{id,title}]}]}`. Includes courses without existing weeks so administrators can map course-level evidence.
- `GET/POST /admin/career/opportunities`, `PATCH/DELETE /admin/career/opportunities/{id}`. List `{items:[Opportunity]}` includes inactive/expired. Input `{title,organization,description,kind,url,location,direction_id:int|null,published_at:ISO|null,expires_at:ISO|null,is_active}`. Empty URL allowed, otherwise HTTP(S), no embedded credentials. Missing published_at uses current UTC. Publication expiry must follow publication.
- `GET /admin/career/overview`: `{students_count,active_skills,active_directions,active_links,active_opportunities,groups:[{id,name,students_count,demonstrated_skills,evidence_count}]}`.
- `GET /admin/career/students?search=...&group_id=1`: `{items:[{id,name,email,group_id,group_name,target_direction_id,target_direction_title,demonstrated_skills,evidence_count,readiness}]}`; max 200, search name/email.
- `GET /admin/career/students/{id}`: same computed student workspace as `/career/me`, for administrator review. No student access to this endpoint.

## Evidence and persistence

Only additive `career_*` tables are created. Initial catalog and conservative source mappings are seeded once using a settings marker, never demo accounts or employee data. Removing all skills or mappings will not trigger reseeding at next start. The suggestion preview/apply operations let administrators handle newly published curricula explicitly. User passwords, groups, tests, submissions and settings are untouched. Shared full database backups/imports naturally include QCareer.

Demonstrated levels are recalculated from current sources on each request and use a maximum, not repeated increments: refreshing/restarting/repeating a save cannot multiply credit. Finished tests require persisted server-generated `source_context` with exact course/group/module/week/work provenance and matching accessible curriculum. Submissions require an administrator-assigned numeric grade/max_score. Existing QStudy retains the `submitted` status after grading, so both `submitted` and `graded` records with a valid grade qualify; draft/unchecked work never qualifies. Deleted/unpublished sources and changed group access revoke derived evidence. No student endpoint accepts skill levels or verification records.

Inactive required skills remain present in direction requirements for administrators to edit safely. Such directions expose `data_complete:false` and `readiness:null` until repaired, preventing an apparent improvement caused by hiding a requirement. No requirements likewise means unknown readiness, not 100%.

An existing learning mapping whose source was withdrawn can be archived with unchanged source references. Creating or reactivating an unavailable mapping is rejected. Administrators can retain archived prerequisites while maintaining a mapping; a hidden prerequisite cannot falsely satisfy an active student's level.

Recommended tests use existing deep links `/dashboard/tests?course=<id>&module=...&weeks=...&works=...&use_web=false`; evidence links open the actual owned result `/dashboard/tests?session=<id>`. Planner search simulates prerequisite and level state for up to three distinct activities, keeps 64 intermediate states, bounds relevant mappings at 200 and discloses truncation in assumptions. It performs no external model request and never changes demonstrated levels.
