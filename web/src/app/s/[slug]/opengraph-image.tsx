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
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 64, background: 'linear-gradient(135deg, #0f0e17 0%, #1a1530 60%, #231a45 100%)', color: '#f4f3f8', fontFamily: 'sans-serif' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ width: 52, height: 52, borderRadius: 14, background: 'linear-gradient(135deg, #8b5cf6, #4f46e5)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, fontWeight: 700 }}>
            {DEFAULT_BRAND.name.charAt(0)}
          </div>
          <div style={{ display: 'flex', fontSize: 30, fontWeight: 700 }}>{DEFAULT_BRAND.name}</div>
          <div style={{ display: 'flex', marginLeft: 12, padding: '6px 16px', borderRadius: 999, background: 'rgba(139, 92, 246, 0.2)', color: '#c4b5fd', fontSize: 22 }}>Shared workflow</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', fontSize: name.length > 42 ? 56 : 68, fontWeight: 700, lineHeight: 1.08, letterSpacing: -1.5 }}>{name}</div>
          {share === null ? null : <div style={{ display: 'flex', fontSize: 28, color: '#a8a3bd' }}>by {share.authorName} · open it, test it, remix it</div>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {steps.map((step, index) => (
            <div key={step.nodeId} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ display: 'flex', padding: '10px 18px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.05)', fontSize: 22 }}>
                {step.def.connector.category === 'core' ? step.title : step.def.connector.name}
              </div>
              {index < steps.length - 1 ? <div style={{ display: 'flex', color: '#8b5cf6', fontSize: 26 }}>→</div> : null}
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
