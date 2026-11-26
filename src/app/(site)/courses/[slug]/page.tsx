import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { resolvePublicCourseRedirect } from "@/features/slug-redirects/service";
import {
  getPublicCourseBySlug,
  getPublicCourseCurriculum,
} from "@/features/courses/sales";
import { parseCourseLanding } from "@/features/courses/metadata";
import { getEffectiveCourseAccessPolicy } from "@/features/offers/service";
import { getOfferAvailability } from "@/features/offers/availability";
import {
  resolveOfferPublicPresentation,
} from "@/features/offers/presentation";
import { publicMetadata } from "@/lib/seo";
import {
  CourseSalesArticle,
  type CourseSalesView,
} from "./course-sales-article";

// Static / ISR: this route reads no request data (no searchParams, cookies
// or headers), so the sales page is prerendered on first request and served
// from the incremental cache. Studio course/offer actions call
// revalidatePath("/courses/<slug>") on every publish, unpublish, archive,
// edit and slug rename, so content still reflects publishes immediately. The
// time-based revalidate is only a safety net for any write path that forgets
// to revalidate. No staff preview: unpublished content 404s here.
export const revalidate = 3600;

// No slugs are known at build time (the build machine's D1 is not the
// production D1); an empty list makes the route ISR instead of dynamic.
export function generateStaticParams() {
  return [];
}

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const { slug } = await props.params;
  const course = await getPublicCourseBySlug(slug);

  if (!course) {
    return {};
  }

  return publicMetadata({
    title: `${course.title} | Decoded Hiring`,
    description:
      course.description || "A practical course from Decoded Hiring.",
    path: `/courses/${slug}`,
    type: "website",
  });
}

function legacyAccessNote(accessMode: string): string {
  if (accessMode === "PAID_ONE_TIME")
    return "This course is paid. Online checkout is not available yet — contact us and we will arrange access.";
  if (accessMode === "MANUAL_INVOICE")
    return "Access is arranged manually by invoice. Contact us to request access.";
  if (accessMode === "PAYMENT_DISABLED")
    return "Online enrollment is currently unavailable. Contact us for options.";
  return "Enrollment is currently unavailable.";
}

function offerAccessNote(accessMode: string, available: boolean): string {
  if (!available) return "This course is not currently accepting new enrollments.";
  if (accessMode === "COMING_SOON")
    return "Enrollment is not open yet. Contact us to register your interest.";
  if (accessMode === "PAID_ONE_TIME")
    return "This course is paid. Online checkout is not active yet, so contact us and we will arrange access.";
  if (accessMode === "MANUAL_INVOICE")
    return "Access is arranged manually by invoice. Contact us to request access.";
  return "Online enrollment is currently unavailable. Contact us for options.";
}

export default async function PublicCourseSalesPage(props: PageProps) {
  const { slug } = await props.params;
  const course = await getPublicCourseBySlug(slug);

  if (!course) {
    const target = await resolvePublicCourseRedirect(slug);
    if (target) permanentRedirect(target);
    notFound();
  }

  const classroomHref = `/learn/courses/${course.slug}`;
  const signupHref = `/signup?redirect=${encodeURIComponent(classroomHref)}`;
  const curriculum = await getPublicCourseCurriculum(course.id);
  const landing = parseCourseLanding(course);
  const access = await getEffectiveCourseAccessPolicy(course);
  const offerPresentation = access.offer
    ? resolveOfferPublicPresentation(access.offer, {
        freeHref: classroomHref,
        freeLabel: "Start learning — free",
        contactHref: "/contact",
      })
    : null;
  // Render-time snapshot only: the ISR shell cannot know the live seat count,
  // so the hero CTA island refreshes it client-side from
  // /api/public/offer-availability. The island also owns the seat/close
  // notices — the server shell renders none, so they can never double up.
  const availability = access.offer
    ? await getOfferAvailability(access.offer.id)
    : null;
  const limitClosed = availability != null && availability.state !== "open";

  const lessons = curriculum.flatMap((entry) => entry.lessons);
  const timed = lessons.filter(
    (lesson) =>
      lesson.durationMinutes !== null &&
      Number.isInteger(lesson.durationMinutes) &&
      lesson.durationMinutes >= 1 &&
      lesson.durationMinutes <= 600,
  );
  const totalMinutes = timed.length
    ? timed.reduce((sum, lesson) => sum + (lesson.durationMinutes ?? 0), 0)
    : null;
  const previewCount = lessons.filter((lesson) => lesson.isPreview).length;

  let view: CourseSalesView;
  if (limitClosed) {
    const soldOut = availability?.state === "sold_out";
    view = {
      slug: course.slug,
      classroomHref,
      signupHref,
      cta: {
        kind: "closed",
        title: soldOut ? "This course is full" : "Enrollment has closed",
        note: soldOut
          ? "This course has sold out."
          : "Enrollment for this course has closed.",
      },
      primaryHref: access.offer?.alternativeCtaUrl ?? "/contact",
      primaryLabel: access.offer?.alternativeCtaLabel ?? "Contact us",
      offerSlug: access.offer ? access.offer.slug : null,
      alternativeLabel: access.offer?.alternativeCtaLabel ?? null,
      alternativeUrl: access.offer?.alternativeCtaUrl ?? null,
      priceLabel: offerPresentation?.priceLabel ?? null,
      priceBadge: offerPresentation?.badge ?? null,
      anonymousHref: null,
      lessonCount: lessons.length,
      lessonLabel:
        lessons.length === 1 ? "1 lesson" : `${lessons.length} lessons`,
      totalTimeLabel: totalMinutes !== null ? `${totalMinutes} min` : null,
      previewCount,
      outcomes: landing.outcomes,
      faq: landing.faq,
    };
  } else if (access.available && access.mode === "FREE") {
    view = {
      slug: course.slug,
      classroomHref,
      signupHref,
      cta: {
        kind: "free",
        title: "Start learning — free",
        note: "Instant enrollment. No checkout, no card.",
      },
      primaryHref: classroomHref,
      primaryLabel: "Start learning — free",
      offerSlug: access.offer ? access.offer.slug : null,
      alternativeLabel: access.offer?.alternativeCtaLabel ?? null,
      alternativeUrl: access.offer?.alternativeCtaUrl ?? null,
      priceLabel: offerPresentation?.priceLabel ?? null,
      priceBadge: offerPresentation?.badge ?? null,
      anonymousHref: signupHref,
      lessonCount: lessons.length,
      lessonLabel:
        lessons.length === 1 ? "1 lesson" : `${lessons.length} lessons`,
      totalTimeLabel: totalMinutes !== null ? `${totalMinutes} min` : null,
      previewCount,
      outcomes: landing.outcomes,
      faq: landing.faq,
    };
  } else if (access.source === "OFFER" && access.offer) {
    view = {
      slug: course.slug,
      classroomHref,
      signupHref,
      cta: {
        kind: "offer",
        title:
          access.mode === "COMING_SOON"
            ? "Enrollment coming soon"
            : "Enrollment on request",
        note: offerAccessNote(access.mode, access.available),
      },
      primaryHref: offerPresentation?.ctaHref ?? "/contact",
      primaryLabel: offerPresentation?.ctaLabel ?? "Contact us",
      offerSlug: access.offer.slug,
      alternativeLabel: access.offer.alternativeCtaLabel,
      alternativeUrl: access.offer.alternativeCtaUrl,
      priceLabel: offerPresentation?.priceLabel ?? null,
      priceBadge: offerPresentation?.badge ?? null,
      anonymousHref: null,
      lessonCount: lessons.length,
      lessonLabel:
        lessons.length === 1 ? "1 lesson" : `${lessons.length} lessons`,
      totalTimeLabel: totalMinutes !== null ? `${totalMinutes} min` : null,
      previewCount,
      outcomes: landing.outcomes,
      faq: landing.faq,
    };
  } else {
    view = {
      slug: course.slug,
      classroomHref,
      signupHref,
      cta: {
        kind: "legacy",
        title: "Enrollment on request",
        note: legacyAccessNote(access.mode),
      },
      primaryHref: "/contact",
      primaryLabel: "Contact us",
      offerSlug: null,
      alternativeLabel: null,
      alternativeUrl: null,
      priceLabel: null,
      priceBadge: null,
      anonymousHref: null,
      lessonCount: lessons.length,
      lessonLabel:
        lessons.length === 1 ? "1 lesson" : `${lessons.length} lessons`,
      totalTimeLabel: totalMinutes !== null ? `${totalMinutes} min` : null,
      previewCount,
      outcomes: landing.outcomes,
      faq: landing.faq,
    };
  }

  return <CourseSalesArticle course={course} view={view} curriculum={curriculum} />;
}
