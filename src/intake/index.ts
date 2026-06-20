// The intake compiler (design §3.11, M6): the bounded conversational agent that
// seeds a run. It grills the human and compiles a structured run seed (outcome spec
// + grounded verifications + a non-binding sketch); committing that seed as the
// `.relay/` root is Phase 2. Phase 1 produces the seed and terminates at approval.
export { compileSeed } from './seed';
export type { IntakeSeed, Sketch } from './seed';
export {
  runIntake,
  parseInterviewerTurn,
  buildInterviewerPrompt,
  buildInterviewerArgs,
  agentInterviewer,
  stdinAsk,
  DEFAULT_MAX_QUESTIONS,
} from './session';
export type {
  IntakeProvider,
  Interviewer,
  InterviewerTurn,
  TranscriptEntry,
  AskHuman,
  IntakeOptions,
  IntakeResult,
  AgentInterviewerOptions,
  InterviewerInvocation,
  InterviewerInvocationResult,
} from './session';
