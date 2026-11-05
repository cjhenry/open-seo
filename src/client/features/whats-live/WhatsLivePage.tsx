import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Info } from "lucide-react";
import { PageHeader } from "@/client/components/PageHeader";
import { EmptyState } from "@/client/components/EmptyState";
import { QueryError } from "@/client/components/QueryState";
import { Button } from "@/client/components/ui/button";
import { Badge } from "@/client/components/ui/badge";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/client/components/ui/alert";
import { whatsLiveQueryOptions } from "@/client/features/whats-live/whatsLiveQueries";
import {
  calendarMonth,
  currentMonthKey,
  dayKey,
  type CalendarMonth,
  type LivePost,
  type PostizUtm,
} from "@/shared/postiz";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PREVIEW_LENGTH = 280;

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function WhatsLivePage() {
  const timeZone = browserTimeZone();
  const [month, setMonth] = useState(() => currentMonthKey(timeZone));
  const [picked, setPicked] = useState<string | null>(null);
  const calendar = calendarMonth(month, timeZone);
  const postsQuery = useQuery({
    ...whatsLiveQueryOptions(month, timeZone),
    enabled: calendar !== null,
  });
  const posts = postsQuery.data?.status === "ok" ? postsQuery.data.posts : [];
  const selected = resolveSelected(calendar, picked, timeZone);
  const dayPosts = posts.filter(
    (post) => dayKey(post.publishDate, timeZone) === selected,
  );
  const counts = countByDay(posts, timeZone);

  return (
    <div className="h-full overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <PageHeader
          title="What's live"
          description={`Published social posts. Times shown in ${timeZone}.`}
          actions={
            calendar ? (
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label="Previous month"
                  onClick={() => setMonth(shiftMonth(month, -1))}
                >
                  <ChevronLeft />
                </Button>
                <span className="min-w-32 text-center text-sm font-medium">
                  {calendar.label}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label="Next month"
                  onClick={() => setMonth(shiftMonth(month, 1))}
                >
                  <ChevronRight />
                </Button>
              </div>
            ) : null
          }
        />

        {postsQuery.data?.source === "fixture" ? (
          <Alert variant="info">
            <Info />
            <AlertTitle>Sample posts</AlertTitle>
            <AlertDescription>
              Postiz is not connected. Set POSTIZ_API_URL and
              POSTIZ_WORK_API_KEY, and leave POSTIZ_USE_FIXTURES unset, to read
              published posts. The key is the existing Postiz work key.
            </AlertDescription>
          </Alert>
        ) : null}

        {postsQuery.isError ? (
          <QueryError
            error={postsQuery.error}
            fallback="Couldn't load published posts."
            onRetry={() => void postsQuery.refetch()}
          />
        ) : postsQuery.data?.status === "unconfigured" ? (
          <EmptyState
            title="Postiz is not connected"
            description="Set POSTIZ_API_URL to your Postiz API root, for example https://social.ict365.ky/api, and POSTIZ_WORK_API_KEY to the work key Postiz ops already uses. Or set POSTIZ_USE_FIXTURES=true to preview this calendar with sample posts."
          />
        ) : postsQuery.data?.status === "error" ? (
          <EmptyState
            kind="error"
            title="Couldn't load published posts"
            description={postsQuery.data.message}
            action={
              <Button
                type="button"
                variant="outline"
                onClick={() => void postsQuery.refetch()}
              >
                Try again
              </Button>
            }
          />
        ) : calendar ? (
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)]">
            <MonthGrid
              calendar={calendar}
              selected={selected}
              counts={counts}
              pending={postsQuery.isPending}
              onSelect={setPicked}
            />
            <DayList
              day={selected}
              timeZone={timeZone}
              posts={dayPosts}
              pending={postsQuery.isPending}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MonthGrid({
  calendar,
  selected,
  counts,
  pending,
  onSelect,
}: {
  calendar: CalendarMonth;
  selected: string | null;
  counts: Map<string, number>;
  pending: boolean;
  onSelect: (day: string) => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-3 sm:p-4">
      <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
        {WEEKDAYS.map((weekday) => (
          <div key={weekday} className="py-1">
            {weekday}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {calendar.cells.map((cell) => {
          const count = counts.get(cell.date) ?? 0;
          const isSelected = cell.date === selected;
          return (
            <button
              key={cell.date}
              type="button"
              aria-pressed={isSelected}
              aria-label={`${cell.date}, ${count} published ${count === 1 ? "post" : "posts"}`}
              onClick={() => onSelect(cell.date)}
              className={`flex min-h-14 flex-col items-center justify-start rounded-md px-1 py-1.5 text-sm transition-colors hover:bg-muted ${
                isSelected ? "bg-primary/10 text-foreground" : ""
              } ${cell.inMonth ? "" : "text-muted-foreground/50"}`}
            >
              <span className="tabular-nums">{Number(cell.date.slice(8))}</span>
              {count > 0 ? (
                <span className="mt-1 rounded-full bg-primary px-1.5 text-[0.625rem] font-medium text-primary-foreground tabular-nums">
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {pending ? (
        <p className="px-1 pt-3 text-sm text-muted-foreground">
          Loading published posts…
        </p>
      ) : null}
    </div>
  );
}

function DayList({
  day,
  timeZone,
  posts,
  pending,
}: {
  day: string | null;
  timeZone: string;
  posts: LivePost[];
  pending: boolean;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">
        {day ? formatDayHeading(day) : "Published posts"}
      </h2>
      {posts.length === 0 && !pending ? (
        <EmptyState
          variant="plain"
          title="Nothing published this day"
          description="Pick another day, or move to a month that has posts."
        />
      ) : (
        <div className="space-y-3">
          {posts.map((post) => (
            <PostCard key={post.id} post={post} timeZone={timeZone} />
          ))}
        </div>
      )}
    </section>
  );
}

function PostCard({ post, timeZone }: { post: LivePost; timeZone: string }) {
  const [expanded, setExpanded] = useState(false);
  const content = post.content.trim();
  const long = content.length > PREVIEW_LENGTH;
  const shown =
    expanded || !long
      ? content
      : `${content.slice(0, PREVIEW_LENGTH).trimEnd()}…`;
  const releaseUrl = httpUrl(post.releaseUrl);
  const channel =
    post.channel.name && post.channel.name !== post.channel.label
      ? `${post.channel.label} · ${post.channel.name}`
      : post.channel.label;

  return (
    <article className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{channel}</Badge>
        <time
          dateTime={post.publishDate}
          className="text-xs text-muted-foreground"
        >
          {formatWhen(post.publishDate, timeZone)}
        </time>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">
        {shown || "No post text"}
      </p>
      {long ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      ) : null}
      <p className="text-sm">
        <span className="text-muted-foreground">Release URL: </span>
        {releaseUrl ? (
          <a
            href={releaseUrl}
            target="_blank"
            rel="noreferrer"
            className="break-all text-foreground underline decoration-foreground/25 underline-offset-4"
          >
            {releaseUrl}
          </a>
        ) : (
          <span className="text-muted-foreground">Not available</span>
        )}
      </p>
      {post.releaseUtm ? (
        <UtmList title="Release URL tracking" utm={post.releaseUtm} />
      ) : null}
      {post.trackedLinks.map((link) => (
        <div key={link.url} className="space-y-2">
          <p className="text-sm">
            <span className="text-muted-foreground">Destination: </span>
            <a
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className="break-all text-foreground underline decoration-foreground/25 underline-offset-4"
            >
              {link.url}
            </a>
          </p>
          <UtmList title="Campaign tracking" utm={link.utm} />
        </div>
      ))}
    </article>
  );
}

function UtmList({ title, utm }: { title: string; utm: PostizUtm }) {
  return (
    <div className="rounded-md bg-muted/60 px-3 py-2">
      <p className="text-xs font-medium">{title}</p>
      <dl className="mt-1 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">Source</dt>
        <dd>{utm.source ?? "Not set"}</dd>
        <dt className="text-muted-foreground">Medium</dt>
        <dd>{utm.medium ?? "Not set"}</dd>
        <dt className="text-muted-foreground">Campaign</dt>
        <dd className="break-all">{utm.campaign ?? "Not set"}</dd>
      </dl>
    </div>
  );
}

function countByDay(posts: LivePost[], timeZone: string) {
  const counts = new Map<string, number>();
  for (const post of posts) {
    const key = dayKey(post.publishDate, timeZone);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function resolveSelected(
  calendar: CalendarMonth | null,
  picked: string | null,
  timeZone: string,
): string | null {
  if (!calendar) return null;
  if (picked && calendar.cells.some((cell) => cell.date === picked))
    return picked;
  const today = dayKey(new Date().toISOString(), timeZone);
  if (
    today &&
    calendar.cells.some((cell) => cell.date === today && cell.inMonth)
  ) {
    return today;
  }
  return calendar.cells.find((cell) => cell.inMonth)?.date ?? null;
}

function shiftMonth(month: string, amount: number): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  const shifted = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1 + amount, 1),
  );
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

function formatWhen(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function formatDayHeading(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return day;
  // Noon UTC stays on this calendar day in every offset, so the heading
  // matches the cell the user clicked.
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, date, 12)));
}

function httpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}
