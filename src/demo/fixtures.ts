import transcripts from "./transcripts.json";
import type { Fields } from "@/domain/qualification/schema";

/**
 * The 20 phone calls from "Aangan Studio — Enquiry Transcripts, September 2026" (anonymised), with the structured
 * facts an extractor would record from each, and the outcome the rubric (qualified.md + services.md) should produce.
 * Used by the test-suite and by DEMO_MODE. These are NOT live data and are labelled `source: "demo"` in the database.
 * Where the source is ambiguous the expectation is AMBER_REVIEW, never an invented rule.
 */

type Turn = { speaker: "human" | "caller"; text: string };
export interface DemoCall {
  id: string;
  from: string | null;
  startedAt: string;
  durationSeconds: number | null;
  endReason: string | null;
  turns: Turn[];
  fields: Partial<Fields>;
  expected: "GREEN_QUALIFIED" | "AMBER_REVIEW" | "RED_NOT_QUALIFIED" | "URGENT_ESCALATION" | "INCOMPLETE";
  note?: string;
}

const T = Object.fromEntries((transcripts as { id: string; turns: Turn[] }[]).map((t) => [t.id, t.turns]));
const ph = (n: number) => `+91900000${String(n).padStart(4, "0")}`;
const at = (day: number, hhmm: string) => `2026-09-${String(day).padStart(2, "0")}T${hhmm}:00+05:30`;

// T17 contains two calls in one source record: split at the second greeting.
const t17 = T["T17"];
const split = t17.findIndex((t, i) => i > 0 && t.text.startsWith("Good afternoon, Aangan Studio"));

export const DEMO_CALLS: DemoCall[] = [
  { id: "T01", from: ph(1), startedAt: at(2, "10:23"), durationSeconds: 252, endReason: "completed", turns: T["T01"], expected: "GREEN_QUALIFIED",
    fields: { call_kind: "new_enquiry", caller_name: "Priya", engagement: "design_and_execution", property_use: "residential", scope_summary: "Full 3BHK redo: kitchen, living room, both bedrooms", ownership: "owner", city: "Pune", locality: "Kothrud", carpet_area_sqft: 1400, timeline_text: "Done by March, no rush", timeline_flexible: true, decision_maker: "authorised_representative", previous_contact_note: "Referred by Shruti Joshi (past client, Aundh)", evidence: { "5": "He knows we're calling and is happy to go ahead." } } },
  { id: "T02", from: ph(2), startedAt: at(3, "14:41"), durationSeconds: 308, endReason: "completed", turns: T["T02"], expected: "GREEN_QUALIFIED",
    fields: { call_kind: "new_enquiry", engagement: "design_and_execution", property_use: "residential", scope_summary: "Full redesign: modular kitchen, wardrobes, living room, both bedrooms (2BHK)", city: "Pune", locality: "Wakad", carpet_area_sqft: 950, deadline_weeks: 9, timeline_text: "Moving in November; design from October", asked_pricing: true } },
  { id: "T03", from: ph(3), startedAt: at(3, "16:15"), durationSeconds: 160, endReason: "completed", turns: T["T03"], expected: "RED_NOT_QUALIFIED",
    fields: { call_kind: "new_enquiry", caller_name: "Suresh Patil", property_use: "residential", scope_summary: "Home office and study", city: "Nashik", evidence: { "2": "I'm in Nashik" } } },
  { id: "T04", from: ph(4), startedAt: at(4, "11:07"), durationSeconds: 202, endReason: "completed", turns: T["T04"], expected: "RED_NOT_QUALIFIED",
    fields: { call_kind: "new_enquiry", engagement: "advice_only", property_use: "residential", scope_summary: "Suggestions on colours and furniture arrangement for living room", evidence: { "1": "Just want suggestions on colours, furniture arrangement" } } },
  { id: "T05", from: ph(5), startedAt: at(5, "10:52"), durationSeconds: 404, endReason: "completed", turns: T["T05"], expected: "GREEN_QUALIFIED",
    fields: { call_kind: "new_enquiry", caller_name: "Aarti Mehta", engagement: "design_and_execution", property_use: "residential", scope_summary: "Complete 4BHK redesign: new flooring, kitchen, four bedrooms", city: "Pune", locality: "Koregaon Park", carpet_area_sqft: 2400, site_readiness: "Family moved out temporarily", deadline_weeks: 17, timeline_text: "Move back by February (~4 months)", previous_contact_note: "Referred by Vikram Agarwal" } },
  { id: "T06", from: ph(6), startedAt: at(5, "15:28"), durationSeconds: 301, endReason: "completed", turns: T["T06"], expected: "GREEN_QUALIFIED",
    fields: { call_kind: "new_enquiry", engagement: "design_and_execution", property_use: "commercial", commercial_kind: "office", scope_summary: "Startup office fitout: 20 workstations, cabin, meeting room, break area", city: "Pune", locality: "Baner", carpet_area_sqft: 800, site_readiness: "Bare shell", deadline_weeks: 13, timeline_text: "Operational by December", decision_maker: "caller_is_decider", evidence: { "5": "Yes, I'm the founder." } } },
  { id: "T07", from: ph(7), startedAt: at(8, "09:44"), durationSeconds: 195, endReason: "completed", turns: T["T07"], expected: "AMBER_REVIEW",
    note: "Wanted it before Diwali (~3 weeks, impossible) but open to a November start; location never stated. Genuinely ambiguous.",
    fields: { call_kind: "new_enquiry", engagement: "design_and_execution", property_use: "residential", scope_summary: "Living room and kitchen", timeline_text: "Wanted before Diwali (~3 weeks); asked about a November start; undecided", preferences_and_concerns: "Will call back after thinking" } },
  { id: "T08", from: ph(8), startedAt: at(9, "22:47"), durationSeconds: 0, endReason: "no-answer", turns: [], expected: "INCOMPLETE",
    note: "Missed after-hours call, no voicemail; the case this system exists for." , fields: {} },
  { id: "T09", from: ph(9), startedAt: at(10, "11:32"), durationSeconds: 352, endReason: "completed", turns: T["T09"], expected: "URGENT_ESCALATION",
    fields: { call_kind: "existing_client_complaint", caller_name: "Sheetal Deshpande", existing_client_designer: "Aryan", city: "Pune", locality: "Viman Nagar", property_details: "2BHK", frustrated: true, preferences_and_concerns: "Wants a callback from Nikhil or a senior person", previous_contact_note: "Three messages and two calls unanswered over five days" } },
  { id: "T10", from: ph(10), startedAt: at(11, "14:04"), durationSeconds: 220, endReason: "completed", turns: T["T10"], expected: "RED_NOT_QUALIFIED",
    fields: { call_kind: "new_enquiry", engagement: "design_and_execution", property_use: "residential", scope_summary: "Kitchen and one bedroom, 1BHK", city: "Pune", locality: "Kharadi", carpet_area_sqft: 550, budget_volunteered_max_inr: 150000, budget_text: "Volunteered a maximum for everything", evidence: { "4": "My budget is 1 to 1.5 lakh maximum for everything." } } },
  { id: "T11", from: ph(11), startedAt: at(12, "10:18"), durationSeconds: 382, endReason: "completed", turns: T["T11"], expected: "AMBER_REVIEW",
    note: "Rented flat is fine and no structural work; only AMBER because no timeline was ever collected (criterion 3 unclear).",
    fields: { call_kind: "new_enquiry", engagement: "design_and_execution", property_use: "residential", scope_summary: "Living room, bedroom and kitchen design and fittings", ownership: "tenant", property_details: "2BHK, 3-year lease, landlord agreed", structural_changes_requested: false, city: "Pune", locality: "Baner", decision_maker: "caller_is_decider" } },
  { id: "T12", from: ph(12), startedAt: at(15, "10:05"), durationSeconds: 450, endReason: "completed", turns: T["T12"], expected: "GREEN_QUALIFIED",
    fields: { call_kind: "new_enquiry", caller_name: "Anand Sharma", engagement: "design_and_execution", property_use: "residential", scope_summary: "Full end-to-end design of villa, ground plus two floors", property_details: "New construction, possession last month, empty", city: "Pune", locality: "Kalyani Nagar", carpet_area_sqft: 5500, deadline_weeks: 24, timeline_flexible: true, timeline_text: "March next year, no rush", preferences_and_concerns: "Wants principal designer on site for first consultation" } },
  { id: "T13", from: ph(13), startedAt: at(16, "12:19"), durationSeconds: 368, endReason: "completed", turns: T["T13"], expected: "AMBER_REVIEW",
    note: "Scope and location are good; timeline never asked.",
    fields: { call_kind: "new_enquiry", engagement: "design_and_execution", property_use: "residential", scope_summary: "Kitchen, wardrobes in both bedrooms, living room (3BHK)", city: "Pune", locality: "Aundh", carpet_area_sqft: 1100, asked_pricing: true } },
  { id: "T14", from: ph(14), startedAt: at(17, "11:41"), durationSeconds: 295, endReason: "completed", turns: T["T14"], expected: "AMBER_REVIEW",
    note: "Caller is the son researching for his parents; qualified.md: not sufficient on its own. Parents will attend.",
    fields: { call_kind: "new_enquiry", property_use: "residential", scope_summary: "Interior design for parents' new 3BHK", city: "Pune", locality: "Hadapsar", decision_maker: "researching_only", ownership: "unknown", previous_contact_note: "Owners are the parents; both will attend the consultation", evidence: { "5": "I'm just calling to see if it's worth pursuing." } } },
  { id: "T15", from: ph(15), startedAt: at(18, "15:12"), durationSeconds: 344, endReason: "completed", turns: T["T15"], expected: "GREEN_QUALIFIED",
    fields: { call_kind: "new_enquiry", caller_name: "Smita", engagement: "design_and_execution", property_use: "residential", scope_summary: "Full home: kitchen, wardrobes, living room", city: "Pune", locality: "Undri", carpet_area_sqft: 875, site_readiness: "Possession in ~6 weeks; builder allows site access now", timeline_flexible: true, timeline_text: "Wants to start design right away", decision_maker: "authorised_representative" } },
  { id: "T16", from: ph(16), startedAt: at(19, "10:38"), durationSeconds: 318, endReason: "completed", turns: T["T16"], expected: "AMBER_REVIEW",
    note: "Caller is frustrated that Monday's enquiry was lost. Project details are thin.",
    fields: { call_kind: "new_enquiry", caller_name: "Girish Nair", property_use: "residential", property_details: "3BHK", city: "Pune", locality: "Viman Nagar", frustrated: true, previous_contact_note: "Called Monday afternoon and gave details; nobody followed up" } },
  { id: "T17a", from: ph(17), startedAt: at(22, "14:14"), durationSeconds: 72, endReason: "disconnected", turns: t17.slice(0, split), expected: "INCOMPLETE", fields: {} },
  { id: "T17b", from: ph(17), startedAt: at(22, "14:16"), durationSeconds: 270, endReason: "completed", turns: t17.slice(split), expected: "GREEN_QUALIFIED",
    fields: { call_kind: "new_enquiry", caller_name: "Ritu Kapoor", engagement: "design_and_execution", property_use: "residential", scope_summary: "Kitchen, wardrobes, living room (3BHK)", city: "Pune", locality: "Pimple Saudagar", carpet_area_sqft: 1050, deadline_weeks: 26, timeline_text: "Done by March, plenty of time", previous_contact_note: "Earlier call dropped after 1m12s" } },
  { id: "T18", from: ph(18), startedAt: at(23, "11:55"), durationSeconds: 182, endReason: "completed", turns: T["T18"], expected: "AMBER_REVIEW",
    note: "180 sq ft coworking pod. The front desk cited a 500 sq ft commercial minimum that is NOT in services.md — so a human decides.",
    fields: { call_kind: "new_enquiry", engagement: "design_and_execution", property_use: "commercial", commercial_kind: "other", scope_summary: "Make a 180 sq ft coworking pod look nice: lighting, desk, storage", carpet_area_sqft: 180 } },
  { id: "T19", from: ph(19), startedAt: at(24, "16:02"), durationSeconds: 170, endReason: "completed", turns: T["T19"], expected: "RED_NOT_QUALIFIED",
    fields: { call_kind: "new_enquiry", property_use: "commercial", commercial_kind: "restaurant", scope_summary: "Restaurant interiors", city: "Pune", locality: "Koregaon Park" } },
  { id: "T20", from: ph(20), startedAt: at(25, "09:15"), durationSeconds: 284, endReason: "completed", turns: T["T20"], expected: "GREEN_QUALIFIED",
    fields: { call_kind: "new_enquiry", caller_name: "Pooja", engagement: "design_and_execution", property_use: "residential", scope_summary: "Kitchen, both bedrooms, living room (2BHK)", city: "Pune", locality: "Magarpatta", carpet_area_sqft: 900, deadline_weeks: 14, timeline_text: "January start for execution", decision_maker: "authorised_representative" } },
];
