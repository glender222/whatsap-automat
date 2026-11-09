import { ReportRepositoryPort } from './ports/ReportRepositoryPort';
import {
  ChatHistoryExport,
  HeatmapMatrix,
  OperationalReportPage,
  OperationalReportRow,
  ReportFilters,
  ReportMetrics,
} from '../domain/report.types';

const DAY_LABELS = ['Dom', 'Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab'];

export class ReportService {
  constructor(private readonly repository: ReportRepositoryPort) {}

  getMetrics(companyId: number, filters: ReportFilters): Promise<ReportMetrics> {
    return this.repository.getMetrics(companyId, filters);
  }

  getOperationalReport(companyId: number, filters: ReportFilters): Promise<OperationalReportPage> {
    return this.repository.getOperationalReport(companyId, filters);
  }

  async getOperationalExport(companyId: number, filters: ReportFilters, format: 'csv' | 'xls') {
    const report = await this.repository.getOperationalReport(companyId, {
      ...filters,
      limit: Math.min(filters.limit, 5000),
      offset: 0,
    });
    const filename = `reporte-operativo-${filters.startDate}-${filters.endDate}.${format}`;

    if (format === 'xls') {
      return {
        filename,
        contentType: 'application/vnd.ms-excel; charset=utf-8',
        content: this.toSpreadsheetXml(report.rows, filters.timezone),
      };
    }

    return {
      filename,
      contentType: 'text/csv; charset=utf-8',
      content: this.toCsv(report.rows, filters.timezone),
    };
  }

  async getHeatmap(companyId: number, filters: ReportFilters): Promise<HeatmapMatrix> {
    const points = await this.repository.getHeatmapPoints(companyId, filters);
    const matrix = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    for (const point of points) {
      if (point.day >= 0 && point.day <= 6 && point.hour >= 0 && point.hour <= 23) {
        matrix[point.day][point.hour] = point.count;
      }
    }

    const values = matrix.flat();
    return {
      days: matrix.map((hours, day) => ({
        day,
        label: DAY_LABELS[day],
        hours,
        total: hours.reduce((sum, count) => sum + count, 0),
      })),
      maxCount: Math.max(0, ...values),
      totalMessages: values.reduce((sum, count) => sum + count, 0),
    };
  }

  getChatHistory(companyId: number, chatId: string, limit: number): Promise<ChatHistoryExport | null> {
    return this.repository.getChatHistory(companyId, chatId, limit);
  }

  private toCsv(rows: OperationalReportRow[], timezone: string): string {
    const headers = [
      'Pedido',
      'Fecha',
      'Cliente',
      'Telefono',
      'Chat',
      'Servicio',
      'Tipo',
      'Clase',
      'Estado',
      'Empleado',
      'Productos',
      'Tipos de item',
      'Cantidad',
      'Reservado',
      'Acciones',
      'Notas',
    ];
    const lines = rows.map((row) => [
      row.orderId,
      this.formatDate(row.occurredAt, timezone),
      row.customerName,
      row.phone || '',
      row.chatId || '',
      row.title,
      row.serviceType,
      row.orderType,
      row.status,
      row.employeeName || '',
      row.products,
      row.itemTypes,
      row.totalQuantity,
      row.reservedQuantity,
      row.actionCount,
      row.notes || '',
    ].map(this.escapeCsv).join(','));
    return `\uFEFF${[headers.join(','), ...lines].join('\r\n')}`;
  }

  private toSpreadsheetXml(rows: OperationalReportRow[], timezone: string): string {
    const headers = ['Pedido', 'Fecha', 'Cliente', 'Telefono', 'Chat', 'Servicio', 'Tipo', 'Clase', 'Estado', 'Empleado', 'Productos', 'Tipos de item', 'Cantidad', 'Reservado', 'Acciones', 'Notas'];
    const values = rows.map((row) => [
      row.orderId,
      this.formatDate(row.occurredAt, timezone),
      row.customerName,
      row.phone || '',
      row.chatId || '',
      row.title,
      row.serviceType,
      row.orderType,
      row.status,
      row.employeeName || '',
      row.products,
      row.itemTypes,
      row.totalQuantity,
      row.reservedQuantity,
      row.actionCount,
      row.notes || '',
    ]);
    const xmlRow = (cells: Array<string | number>) => (
      `<Row>${cells.map((cell) => `<Cell><Data ss:Type="${typeof cell === 'number' ? 'Number' : 'String'}">${this.escapeXml(String(cell))}</Data></Cell>`).join('')}</Row>`
    );

    return `<?xml version="1.0"?>\n` +
      `<?mso-application progid="Excel.Sheet"?>\n` +
      `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">` +
      `<Worksheet ss:Name="Reporte"><Table>${xmlRow(headers)}${values.map(xmlRow).join('')}</Table></Worksheet>` +
      `</Workbook>`;
  }

  private formatDate(value: Date, timezone: string): string {
    return new Intl.DateTimeFormat('es-PE', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(value));
  }

  private escapeCsv(value: unknown): string {
    const text = String(value ?? '');
    const formula = typeof value === 'string' && /^(?:[\t\r\n]|\s*[=+@-])/.test(text);
    return `"${formula ? "'" : ''}${text.replace(/"/g, '""')}"`;
  }

  private escapeXml(value: string): string {
    return value.replace(/[<>&'"]/g, (character) => ({
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;',
      "'": '&apos;',
      '"': '&quot;',
    }[character] || character));
  }
}
