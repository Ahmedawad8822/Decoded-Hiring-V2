// ============================================================================
// SCHEDULING DOMAIN — PUBLIC API BARREL (Mission 08.1)
// =============================================================================

// Domain error types (Mission 08.1 remediation §3)
export { SchedulingDomainError } from "./errors";
export type { SchedulingDomainErrorCode } from "./errors";

// Types
export type {
  ConfirmationPolicy,
  BookingAccessMode,
  MeetingMethod,
  SlotHoldStatus,
  CanonicalSlot,
  AcquireHoldResult,
  AcquireHoldSuccess,
  AcquireHoldFailure,
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
  UpdateBookingTypeInput,
  CreateAvailabilityWindowInput,
  AcquireSlotHoldInput,
  MutateSlotHoldInput,
} from "./schemas";

// Zod schemas
export {
  createBookingTypeSchema,
  updateBookingTypeSchema,
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
  generateAcquisitionKey,
  safeView,
} from "./holds";

// Policy / service layer
export {
  createBookingType,
  updateBookingType,
  getBookingTypeBySlug,
  getBookingTypeById,
  getActiveBookingType,
  listBookingTypes,
  listAllBookingTypes,
  createAvailabilityWindow,
  getBookingTypeWindows,
  getActiveBookingTypeWithWindows,
} from "./policy";

// Provider contracts
export {
  UnconfiguredPaymentGateway,
  NullCalendarProvider,
  UnconfiguredMailboxProvider,
  UnconfiguredMeetingProvider,
  UnconfiguredCommerceSchedulingProviders,
  SchedulingProviderError,
} from "./providers";
export type {
  ProviderKind,
  ProviderRuntimeStatus,
  SchedulingProviderErrorCode,
  CalendarProvider,
  PaymentGateway,
  MailboxProvider,
  MeetingProvider,
  CommerceSchedulingProviders,
  CalendarEventRef,
  FreeBusyRequest,
  FreeBusyEntry,
  CreateCalendarEventParams,
  CreateCalendarEventResult,
  UpdateCalendarEventParams,
  CancelCalendarEventParams,
  EmailAttendee,
  NormalizedPaymentState,
  CheckoutResult,
  PaymentCustomer,
  CreateCheckoutParams,
  VerifyCallbackParams,
  VerifyCallbackResult,
  VerifyWebhookSignatureParams,
  VerifyWebhookSignatureResult,
  VerifyWebhookPaymentParams,
  VerifyWebhookPaymentResult,
  NormalizePaymentStateParams,
  NormalizePaymentStateResult,
  RefundOrCancelParams,
  SendEmailParams,
  MailboxMessageRef,
  MeetingLocationParams,
  ResolvedMeetingLocation,
} from "./providers";


// Booking lifecycle (Mission 08.2)
export {
  createBookingRequest,
  getBookingForAdmin,
  getBookingHistoryForAdmin,
  confirmBooking,
  approveBooking,
  declineBooking,
  cancelBooking,
  completeBooking,
  rescheduleBooking,
} from "./bookings";
export {
  createBookingRequestSchema,
  bookingTransitionSchema,
  bookingDecisionSchema,
  rescheduleBookingSchema,
} from "./booking-schemas";
export type {
  CreateBookingRequestInput,
  BookingTransitionInput,
  BookingDecisionInput,
  RescheduleBookingInput,
} from "./booking-schemas";
export type {
  Booking,
  BookingHistory,
  BookingStatus,
  BookingHistoryAction,
} from "@/lib/db";
