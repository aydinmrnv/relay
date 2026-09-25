import { ImageResponse } from 'next/og';
import { DEFAULT_BRAND } from '@/lib/brand';
import { describeWorkflow } from '@/lib/workflow/describe';
import { databaseConfigured } from '@/server/db';
import { getPublicShare } from '@/server/studio';

export const alt = 'A shared workflow';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/** The card a shared link unfurls into: what the workflow is called, who made it, and its steps in order. */
export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const share = databaseConfigured() ? await getPublicShare(slug).catch(() => null) : null;
  const name = share?.workflow.name ?? 'Workflow not found';
  const steps = share === null ? [] : describeWorkflow(share.workflow).steps.filter((step) => step.depth === 0).slice(0, 6);
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 64, background: '#0f0e0c', color: '#fafaf9', fontFamily: 'sans-serif' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ width: 52, height: 52, borderRadius: 12, background: '#fafaf9', color: '#1a1815', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, fontWeight: 700 }}>
            {DEFAULT_BRAND.name.charAt(0)}
          </div>
          <div style={{ display: 'flex', fontSize: 30, fontWeight: 700 }}>{DEFAULT_BRAND.name}</div>
          <div style={{ display: 'flex', marginLeft: 12, padding: '6px 16px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.18)', color: '#b5b1aa', fontSize: 22 }}>Shared workflow</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', fontSize: name.length > 42 ? 56 : 68, fontWeight: 700, lineHeight: 1.08, letterSpacing: -1.5 }}>{name}</div>
          {share === null ? null : <div style={{ display: 'flex', fontSize: 28, color: '#b5b1aa' }}>by {share.authorName} · open it, test it, remix it</div>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {steps.map((step, index) => (
            <div key={step.nodeId} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ display: 'flex', padding: '10px 18px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.14)', fontSize: 22 }}>
                {step.def.connector.category === 'core' ? step.title : step.def.connector.name}
              </div>
              {index < steps.length - 1 ? <div style={{ display: 'flex', color: '#5f5b55', fontSize: 26 }}>→</div> : null}
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
