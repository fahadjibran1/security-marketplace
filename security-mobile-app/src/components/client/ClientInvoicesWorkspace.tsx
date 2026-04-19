import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatApiErrorMessage, getClientPortalInvoiceDocument } from '../../services/api';
import { ClientPortalInvoiceSummary, InvoiceDocument } from '../../types/models';

const MONEY = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });

function downloadInvoiceHtml(document: InvoiceDocument) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${document.invoiceNumber}</title></head><body style="font-family:Arial,sans-serif;padding:32px;color:#0f172a">
  <h1>${document.company.name}</h1>
  <p>${document.company.address || ''}</p>
  <hr/>
  <h2>Invoice ${document.invoiceNumber}</h2>
  <p>Issue date: ${document.issueDate}</p>
  <p>Due date: ${document.dueDate}</p>
  <h3>Client</h3>
  <p>${document.client.name}</p>
  <p>${document.client.billingAddress || ''}</p>
  <table border="1" cellspacing="0" cellpadding="8" style="border-collapse:collapse;width:100%;margin-top:16px">
  <tr><th>Site</th><th>Date</th><th>Hours</th><th>Rate</th><th>Amount</th></tr>
  ${document.lineItems.map((item) => `<tr><td>${item.site}</td><td>${item.shiftDate}</td><td>${item.billableHours}</td><td>${item.billingRate ?? ''}</td><td>${item.amount}</td></tr>`).join('')}
  </table>
  <h3 style="margin-top:16px">Total: ${document.totals.grossAmount}</h3>
  </body></html>`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement('a');
  link.href = url;
  link.download = `invoice-${document.invoiceNumber}.html`;
  window.document.body.appendChild(link);
  link.click();
  window.document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function ClientInvoicesWorkspace({ invoices }: { invoices: ClientPortalInvoiceSummary[] }) {
  const [selectedDocument, setSelectedDocument] = React.useState<InvoiceDocument | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const handleViewInvoice = React.useCallback(async (invoiceId: number) => {
    setError(null);
    try {
      const document = await getClientPortalInvoiceDocument(invoiceId);
      setSelectedDocument(document);
    } catch (err) {
      setError(formatApiErrorMessage(err, 'Unable to load the invoice document.'));
    }
  }, []);

  return (
    <View style={styles.stack}>
      <View style={styles.panel}>
        <Text style={styles.title}>Invoices</Text>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {invoices.length === 0 ? (
          <Text style={styles.helperText}>No invoices are currently available.</Text>
        ) : (
          invoices.map((invoice) => (
            <View key={invoice.id} style={styles.row}>
              <View style={styles.flexGrow}>
                <Text style={styles.rowTitle}>{invoice.invoiceNumber}</Text>
                <Text style={styles.meta}>Issued: {invoice.issueDate} · Due: {invoice.dueDate || 'Not set'}</Text>
              </View>
              <Text style={styles.amount}>{MONEY.format(Number(invoice.amount || 0))}</Text>
              <Pressable style={styles.viewButton} onPress={() => handleViewInvoice(invoice.id)}>
                <Text style={styles.viewButtonText}>View</Text>
              </Pressable>
            </View>
          ))
        )}
      </View>

      {selectedDocument ? (
        <View style={styles.panel}>
          <View style={styles.documentHeader}>
            <View style={styles.flexGrow}>
              <Text style={styles.title}>Invoice Document</Text>
              <Text style={styles.meta}>{selectedDocument.invoiceNumber} · {selectedDocument.client.name}</Text>
            </View>
            <Pressable style={styles.viewButton} onPress={() => downloadInvoiceHtml(selectedDocument)}>
              <Text style={styles.viewButtonText}>Download</Text>
            </Pressable>
          </View>
          {selectedDocument.lineItems.map((item) => (
            <View key={`${selectedDocument.id}-${item.timesheetId}`} style={styles.row}>
              <View style={styles.flexGrow}>
                <Text style={styles.rowTitle}>{item.site}</Text>
                <Text style={styles.meta}>{item.shiftDate} · {item.billableHours}h</Text>
              </View>
              <Text style={styles.amount}>{MONEY.format(Number(item.amount || 0))}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 18 },
  panel: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 18, padding: 18, gap: 12 },
  title: { color: '#0F172A', fontSize: 22, fontWeight: '800' },
  helperText: { color: '#64748B' },
  errorText: { color: '#B91C1C', fontWeight: '700' },
  row: { flexDirection: 'row', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F1F5F9', alignItems: 'center' },
  flexGrow: { flex: 1 },
  rowTitle: { color: '#0F172A', fontWeight: '800' },
  meta: { color: '#64748B', marginTop: 3 },
  amount: { color: '#0F172A', fontWeight: '800' },
  viewButton: { borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
  viewButtonText: { color: '#0F172A', fontWeight: '700' },
  documentHeader: { flexDirection: 'row', gap: 12, alignItems: 'center' },
});
