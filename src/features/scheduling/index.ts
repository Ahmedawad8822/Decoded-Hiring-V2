// ============================================================================
// SCHEDULING DOMAIN — PUBLIC API BARREL (Mission 08.1)
// ============================================================================

// Types
export type {
  ConfirmationPolicy,
  BookingAccessMode,
  MeetingMethod,
  SlotHoldStatus,
  CanonicalSlot,
  AcquireHoldResult,
  HoldRejectionReason,
  SlotHoldLike,
  SafeHoldView,
  MutateHoldResult,
  BookingType,
  BookingAvailabilityWindow,
  SlotHold,
} from "./types";
export type {
  CreateBookingTypeInput,
  CreateAvailabilityWindowInput,
  AcquireSlotHoldInput,
  MutateSlotHoldInput,
} from "./schemas";

// Zod schemas
export {
  createBookingTypeSchema,
  createAvailabilityWindowSchema,
  acquireSlotHoldSchema,
  mutateSlotHoldSchema,
  IANAtimezoneSchema,
  confirmationPolicySchema,
  bookingAccessModeSchema,
  meetingMethodSchema,
} from "./schemas";

// Timezone utilities
export {
  isValidIanaTimezone,
  getLocalDateParts,
  getLocalWallClock,
  getWeekdayInTz,
  getTimezoneOffsetMs,
  localTimeToUtc,
} from "./time";
export { NonexistentTimeError, AmbiguousTimeError } from "./time";

// Canonical slot generation
export { buildSlotKey, generateCandidateSlots } from "./availability";

// Hold lease management
export {
  acquireSlotHold,
  releaseSlotHold,
  consumeSlotHold,
  generateOwnerToken,
  safeView,
} from "./holds";

// Policy / service layer
export {
  createBookingType,
  getBookingTypeBySlug,
  getBookingTypeById,
  getActiveBookingType,
  listBookingTypes,
  createAvailabilityWindow,
  getBookingTypeWindows,
  getActiveBookingTypeWithWindows,
} from "./policy";

// Provider contracts
export {
  UnconfiguredPaymentGateway,
  NullCalendarProvider,
  SchedulingProviderError,
} from "./providers";
export type {
  CalendarProvider,
  PaymentGateway,
  MailboxProvider,
  MeetingProvider,
  CalendarEventRef,
  FreeBusyRequest,
  FreeBusyEntry,
  CreateCalendarEventParams,
  EmailAttendee,
  CheckoutResult,
  CreateCheckoutParams,
  VerifyCallbackParams,
  VerifyCallbackResult,
  SendEmailParams,
  MeetingLocationParams,
  ResolvedMeetingLocation,
} from "./providers";
