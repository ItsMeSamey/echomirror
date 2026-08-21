export interface ApiResponse {
  readonly status: string;
  readonly data: SyllabusLesson[];
}

export interface SyllabusLesson {
  readonly lesson: {
    readonly hasVideo: boolean;
    readonly startTimeUTC?: string | null;
    readonly medias?: ReadonlyArray<{ readonly title: string }>;
    readonly lesson: {
      readonly id: string;
      readonly sectionId: string;
      readonly name: string;
      readonly displayName: string;
      readonly lessonHasName: boolean;
      readonly createdAt: string;
      readonly timing?: { readonly start: string };
    };
  };
  readonly type: string;
}
