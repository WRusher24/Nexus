'use client';

/**
 * Evidence card (M9, Part 4.2): a verbatim quote plus its pinned source
 * revision. Because the source is addressed by `oldid`, the link always
 * resolves to the exact revision the quote was verified against.
 */

import type { EvidenceSpanDetail } from '@/lib/frontend/types';

interface EvidenceCardProps {
  evidence: EvidenceSpanDetail;
}

function sourceUrl(evidence: EvidenceSpanDetail): string | null {
  const source = evidence.sourceDocument;
  if (!source) return null;
  const title = encodeURIComponent(source.wikipediaTitle.replace(/ /g, '_'));
  return `https://en.wikipedia.org/w/index.php?title=${title}&oldid=${source.revisionId}`;
}

export default function EvidenceCard({ evidence }: EvidenceCardProps) {
  const url = sourceUrl(evidence);
  const verified = evidence.verificationStatus === 'VERIFIED';

  return (
    <div
      data-testid="evidence-card"
      className="rounded-md border border-gray-200 bg-gray-50 p-2 text-xs"
    >
      <blockquote className="border-l-2 border-gray-300 pl-2 italic text-gray-800">
        “{evidence.quoteText}”
      </blockquote>

      <dl className="mt-2 space-y-0.5 text-gray-600">
        {evidence.sectionTitle ? (
          <div>
            <dt className="inline font-medium text-gray-500">Section: </dt>
            <dd className="inline">{evidence.sectionTitle}</dd>
          </div>
        ) : null}
        {evidence.sourceDocument ? (
          <div>
            <dt className="inline font-medium text-gray-500">Source: </dt>
            <dd className="inline">
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 hover:underline"
                >
                  {evidence.sourceDocument.wikipediaTitle} (rev.{' '}
                  {evidence.sourceDocument.revisionId})
                </a>
              ) : (
                `${evidence.sourceDocument.wikipediaTitle} (rev. ${evidence.sourceDocument.revisionId})`
              )}
            </dd>
          </div>
        ) : null}
      </dl>

      <span
        className={`mt-2 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
          verified
            ? 'bg-green-100 text-green-800'
            : 'bg-yellow-100 text-yellow-800'
        }`}
      >
        {verified ? '✓ Verified' : evidence.verificationStatus}
      </span>
    </div>
  );
}
