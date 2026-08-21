// Main Interface
export interface Echo360Data {
  canViewAnalytics: boolean;
  captions: string;
  context: Context;
  chapters: null;
  copyrightData: CopyrightData;
  polls: unknown[];
  cookieRenewalIntervalMillis: number;
  heatmapData: number[];
  lesson: Lesson;
  locale: string;
  isMuted: boolean;
  isPlaying: boolean;
  sectionInfo: SectionInfo;
  slides: Slides;
  startTimeMillis: number;
  viewEmbedInfo: ViewEmbedInfo;
  hasContent: boolean;
  user: User;
  title: string;
  video: Video;
  sessionId: string;
  liveLessonInfo: null;
  liveTrackingInfo: null;
  isMobile: boolean;
  playerBranding: null;
  id: string;
}

// Nested Interfaces
export interface Context {
  courseId: string;
  lessonId: string;
  sectionId: string;
  termId: string;
}

export interface CopyrightData {
  copyrightEnabled: boolean;
  enabledPrivileges: unknown[];
  restrictDownload: boolean;
  restrictUnauthenticatedViewing: boolean;
  enforceCopyrightAcknowledgement: boolean;
  copyrightPolicyText: null;
  copyrightAcknowledged: boolean;
}

export interface Lesson {
  id: string;
  institutionId: string;
  sectionId: string;
  captureOccurrenceId: string;
  name: string;
  timing: Timing;
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

export interface SectionInfo {
  section: Section;
  course: Course;
  term: Term;
  label: string;
  isFolder: boolean;
}

export interface Section {
  id: string;
  institutionId: string;
  courseId: string;
  termId: string;
  scheduleIds: unknown[];
  sectionNumber: string;
  description: string;
  gradeType: string;
  createdAt: string;
  updatedAt: string;
  isFolder: boolean;
}

export interface Course {
  id: string;
  institutionId: string;
  courseName: string;
  courseIdentifier: string;
  sectionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Term {
  id: string;
  institutionId: string;
  name: string;
  session: Session;
  exceptions: unknown[];
  sectionCount: number;
  lmsSelected: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  startDate: string;
  endDate: string;
}

export interface Slides {
  slideDeck: null;
  slidesWithImages: null;
  startSlideIndex: null;
}

export interface ViewEmbedInfo {
  linkId: string;
  mediaName: string;
  loggedIn: boolean;
  loginCheck: boolean;
  autoPlay: boolean;
  autoMute: boolean;
  lastPlayedToSeconds: number;
  playerType: string;
}

export interface User {
  services: Services;
  name: string;
  createdOn: string;
  email: string;
  currentRole: string;
  preference: Preference;
  privileges: unknown[];
  institutions: InstitutionElement[];
  isLtiSession: boolean;
  lastName: string;
  firstName: string;
  id: string;
  timeZoneId: string;
  status: string;
  currentInstitutionRoles: string[];
  eulaVersion: number;
  timeZoneOffsetMinutes: number;
  currentInstitution: CurrentInstitution;
  timeZone: string;
  userPermissions: {};
}

export interface Services {
  embedly: Embedly;
  pubnub: PubNub;
  filestack: Filestack;
  airbrake: Airbrake;
  folders: Folders;
  zoomUserMeeting: ZoomUserMeeting;
}

export interface Embedly {
    isSecure: boolean;
    key: string;
    baseUrl: string;
    isFrame: boolean;
    echoDomainList: string[];
}

export interface PubNubConfig {
    authKey: string;
    suppressLeaveEvents: boolean;
    restore: boolean;
    uuid: string;
    presenceTimeout: number;
    useRandomIVs: boolean;
    cipherKey: string;
    useRequestId: boolean;
    subscribeKey: string;
    publishKey: string;
    heartbeatInterval: number;
}

export interface PubNub {
    nonPresenceConfig: PubNubConfig;
    forPresenceConfig: PubNubConfig;
    legacyConfig: PubNubConfig;
}

export interface Filestack {
    apikey: string;
    baseUrl: string;
    pickerOptions: PickerOptions;
    protocol: string;
}

export interface PickerOptions {
    uploadConfig: {
        concurrency: number;
        partSize: number;
        retry: number;
        timeout: number;
    };
    uploadInBackground: boolean;
    concurrency: number;
    storeTo: {
        container: string;
        region: string;
        access: string;
        location: string;
    };
    maxFiles: number;
    maxSize: number;
    fromSources: string[];
}

export interface Airbrake {
    projectId: string;
    projectKey: string;
    environment: string;
}

export interface Folders {
    bucket: string;
}

export interface ZoomUserMeeting {
    canCreate: boolean;
}


export interface Preference {
  player: PlayerPreference;
}

export interface PlayerPreference {
  closedCaption: ClosedCaptionPreference;
  transcript: TranscriptPreference;
  overlayToggle: string;
}

export interface ClosedCaptionPreference {
  contrast: string;
  location: string;
  size: string;
  visible: boolean;
}

export interface TranscriptPreference {
  visible: boolean;
}

export interface InstitutionElement {
  id: string;
  name: string;
  currentUserRoles: string[];
}

export interface CurrentInstitution {
  id: string;
  name: string;
  toggles: Toggle[];
  isLmsApiConfigured: boolean;
}

export interface Toggle {
  name: string;
  enabled: boolean;
}

export interface Video {
  disableAutoBandwidth: boolean;
  duration: string;
  mediaId: string;
  playableMedias: PlayableMedia[];
  posterMedia: PosterMedia[];
  thumbnailMedia: ThumbnailMedia[];
  liveTimeAvailable: boolean;
}

export interface PlayableMedia {
  isHls: boolean;
  isLive: boolean;
  quality: number[];
  sourceIndex: number;
  trackType: string[];
  uri: string;
}

export interface PosterMedia {
  sourceIndex: number;
  uri: string;
}

export interface ThumbnailMedia {
  baseUri: string;
  extension: string;
  sourceIndex: number;
  timesInSeconds: number[];
}
