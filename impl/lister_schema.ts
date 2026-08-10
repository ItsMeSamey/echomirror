export interface ApiResponse {
  status: string;
  message: string;
  data: SyllabusLesson[];
}

export interface SyllabusLesson {
  lesson: LessonWrapper;
  type: string; // e.g., "SyllabusLessonType"
}

export interface LessonWrapper {
  lesson: LessonDetails;
  medias: Media[];
  userSectionRole: string;
  captureStartedAt?: string; // Appears optional for some non-scheduled lessons
  captureEndedAt?: string;   // Appears optional
  questionCount: number;
  isScheduled: boolean;
  hasContent: boolean;
  hasVideo: boolean;
  hasVideoHiddenDueToCaptions: boolean;
  hasSlideDeck: boolean;
  isLive: boolean;
  isInteractiveMedia: boolean;
  isPast: boolean;
  isFuture: boolean;
  is360Video: boolean;
  isAudioOnly: boolean;
  startTimeUTC: string | null;
  endTimeUTC: string | null;
}

export interface LessonDetails {
  id: string;
  institutionId: string;
  sectionId: string;
  captureOccurrenceId?: string; // Appears optional
  name: string;
  timing?: Timing; // Appears optional for non-scheduled lessons
  timeZone: TimeZone;
  fromSchedule: boolean;
  shouldStreamLive: boolean;
  createdAt: string;
  updatedAt: string;
  isFolderLesson: boolean;
  displayName: string;
  lessonHasName: boolean;
}

export interface Timing {
  start: string;
  end: string;
}

export interface TimeZone {
  id: string;
  name: string;
  standardOffset: string;
}

export interface Media {
  id: string;
  mediaType: string;
  title: string;
  isAvailable: boolean;
  isHiddenDueToCaptions: boolean;
  isRead: boolean;
  isScheduled: boolean;
  isProcessing: boolean;
  isFailed: boolean;
  isPreliminary: boolean;
  isInteractiveMedia: boolean;
  is360Video: boolean;
  isAudioOnly: boolean;
  thumbnailUri: string;
  captureOccurrenceId: string;
}
