import React from 'react';
import { Document, Page, Text, View, StyleSheet, renderToStream } from '@react-pdf/renderer';
import type { ParticipationStats } from '@hna/shared';

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 11, fontFamily: 'Helvetica' },
  h1: { fontSize: 20, marginBottom: 12, color: '#512888' },
  h2: { fontSize: 14, marginTop: 16, marginBottom: 6 },
  row: { flexDirection: 'row', borderBottom: '1 solid #ddd', paddingVertical: 3 },
  cellWide: { flex: 3 },
  cellNarrow: { flex: 1, textAlign: 'right' },
});

export function ParticipationPdf({
  stats,
  clubName,
}: {
  stats: ParticipationStats;
  clubName: string;
}) {
  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.h1}>{clubName} — Participation Report</Text>
        <Text>
          Range: {stats.range.from.slice(0, 10)} to {stats.range.to.slice(0, 10)}
        </Text>
        <Text>
          Total sessions: {stats.totalSessions} · Total check-ins: {stats.totalCheckIns}
        </Text>

        <Text style={styles.h2}>Per member</Text>
        {stats.perMember.map((m) => (
          <View style={styles.row} key={m.callsign}>
            <Text style={styles.cellWide}>
              {m.callsign} — {m.name}
            </Text>
            <Text style={styles.cellNarrow}>{m.count}</Text>
          </View>
        ))}

        <Text style={styles.h2}>Per net</Text>
        {stats.perNet.map((n) => (
          <View style={styles.row} key={n.netId}>
            <Text style={styles.cellWide}>{n.netName}</Text>
            <Text style={styles.cellNarrow}>
              {n.sessions} sess · {n.checkIns} ins
            </Text>
          </View>
        ))}
      </Page>
    </Document>
  );
}

export async function renderParticipationPdf(
  stats: ParticipationStats,
  clubName: string,
): Promise<NodeJS.ReadableStream> {
  return renderToStream(<ParticipationPdf stats={stats} clubName={clubName} />);
}
