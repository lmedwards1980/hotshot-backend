/**
 * Invoice Service - PDF Generation for Hotshot Platform
 * Generates invoices for shippers, earnings statements for drivers/dispatchers
 */

const PDFDocument = require('pdfkit');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');

// S3 Client
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.S3_BUCKET_NAME || 'hotshot-files-uploads';

// Colors
const colors = {
  primary: '#6366f1',
  success: '#22c55e',
  text: '#1a1a1a',
  textSecondary: '#64748b',
  border: '#e2e8f0',
};

/**
 * Generate Shipper Invoice PDF
 */
async function generateShipperInvoice(load, shipper, payment) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
      const chunks = [];

      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', async () => {
        const pdfBuffer = Buffer.concat(chunks);
        
        // Upload to S3
        const key = `invoices/shipper/${shipper.id}/INV-${load.id.slice(0, 8).toUpperCase()}.pdf`;
        
        await s3Client.send(new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: pdfBuffer,
          ContentType: 'application/pdf',
        }));

        const url = `https://${BUCKET}.s3.amazonaws.com/${key}`;
        resolve({ url, key });
      });
      doc.on('error', reject);

      // Header
      doc.fontSize(24).fillColor(colors.primary).text('HOTSHOT', 50, 50);
      doc.fontSize(10).fillColor(colors.textSecondary).text('Freight Delivery Platform', 50, 78);

      // Invoice Title
      doc.fontSize(20).fillColor(colors.text).text('INVOICE', 400, 50, { align: 'right' });
      
      // Invoice Details
      const invoiceNumber = `INV-${new Date().getFullYear()}-${load.id.slice(0, 8).toUpperCase()}`;
      doc.fontSize(10).fillColor(colors.textSecondary);
      doc.text(`Invoice #: ${invoiceNumber}`, 400, 78, { align: 'right' });
      doc.text(`Date: ${formatDate(new Date())}`, 400, 92, { align: 'right' });
      doc.text(`Load #: ${load.id.slice(0, 8).toUpperCase()}`, 400, 106, { align: 'right' });

      // Divider
      doc.moveTo(50, 140).lineTo(562, 140).strokeColor(colors.border).stroke();

      // Bill To Section
      doc.fontSize(10).fillColor(colors.textSecondary).text('BILL TO', 50, 160);
      doc.fontSize(12).fillColor(colors.text);
      doc.text(shipper.company_name || `${shipper.first_name} ${shipper.last_name}`, 50, 178);
      doc.fontSize(10).fillColor(colors.textSecondary);
      doc.text(shipper.email, 50, 195);
      if (shipper.phone) doc.text(shipper.phone, 50, 210);

      // Load Details Section
      doc.fontSize(10).fillColor(colors.textSecondary).text('LOAD DETAILS', 300, 160);
      doc.fontSize(11).fillColor(colors.text);
      doc.text(`Type: ${(load.load_type || 'Standard').toUpperCase()}`, 300, 178);
      doc.text(`Distance: ${load.distance_miles?.toFixed(0) || '—'} miles`, 300, 195);
      doc.text(`Delivered: ${load.delivered_at ? formatDate(load.delivered_at) : 'Pending'}`, 300, 212);

      // Route Box
      const routeY = 260;
      doc.roundedRect(50, routeY, 512, 80, 5).fillColor('#f8fafc').fill();
      
      // Pickup
      doc.circle(80, routeY + 25, 6).fillColor(colors.success).fill();
      doc.fontSize(9).fillColor(colors.textSecondary).text('PICKUP', 100, routeY + 12);
      doc.fontSize(11).fillColor(colors.text).text(
        `${load.pickup_city}, ${load.pickup_state}`,
        100, routeY + 26
      );
      doc.fontSize(9).fillColor(colors.textSecondary).text(
        load.pickup_address || '',
        100, routeY + 42
      );

      // Arrow
      doc.fontSize(16).fillColor(colors.textSecondary).text('→', 280, routeY + 25);

      // Delivery
      doc.circle(320, routeY + 25, 6).fillColor('#ef4444').fill();
      doc.fontSize(9).fillColor(colors.textSecondary).text('DELIVERY', 340, routeY + 12);
      doc.fontSize(11).fillColor(colors.text).text(
        `${load.delivery_city}, ${load.delivery_state}`,
        340, routeY + 26
      );
      doc.fontSize(9).fillColor(colors.textSecondary).text(
        load.delivery_address || '',
        340, routeY + 42
      );

      // Charges Table
      const tableY = 370;
      doc.fontSize(10).fillColor(colors.textSecondary).text('CHARGES', 50, tableY);
      
      // Table Header
      doc.rect(50, tableY + 20, 512, 25).fillColor('#f1f5f9').fill();
      doc.fontSize(10).fillColor(colors.textSecondary);
      doc.text('Description', 60, tableY + 28);
      doc.text('Amount', 480, tableY + 28, { align: 'right' });

      // Calculate pricing breakdown
      const baseRate = getBaseRate(load.load_type);
      const perMile = getPerMileRate(load.load_type);
      const mileageCharge = (load.distance_miles || 0) * perMile;

      // Table Rows
      let rowY = tableY + 50;
      doc.fontSize(11).fillColor(colors.text);
      
      // Base Rate
      doc.text(`Base Rate (${(load.load_type || 'Standard').toUpperCase()})`, 60, rowY);
      doc.text(formatCurrency(baseRate), 480, rowY, { align: 'right' });
      rowY += 25;

      // Mileage
      doc.text(`Mileage (${load.distance_miles?.toFixed(0) || 0} mi × ${formatCurrency(perMile)})`, 60, rowY);
      doc.text(formatCurrency(mileageCharge), 480, rowY, { align: 'right' });
      rowY += 25;

      // Expedited fee if applicable
      if (load.expedited_fee && load.expedited_fee > 0) {
        doc.text('Expedited Fee', 60, rowY);
        doc.text(formatCurrency(load.expedited_fee), 480, rowY, { align: 'right' });
        rowY += 25;
      }

      // Divider
      doc.moveTo(50, rowY + 5).lineTo(562, rowY + 5).strokeColor(colors.border).stroke();
      rowY += 20;

      // Total
      doc.fontSize(14).fillColor(colors.text).font('Helvetica-Bold');
      doc.text('TOTAL', 60, rowY);
      doc.text(formatCurrency(load.price), 480, rowY, { align: 'right' });

      // Payment Info
      const paymentY = rowY + 60;
      doc.roundedRect(50, paymentY, 512, 50, 5).fillColor('#f0fdf4').fill();
      doc.circle(75, paymentY + 25, 12).fillColor(colors.success).fill();
      doc.fontSize(14).fillColor('#ffffff').text('✓', 70, paymentY + 18);
      
      doc.fontSize(12).fillColor(colors.success).font('Helvetica-Bold');
      doc.text('PAID', 100, paymentY + 12);
      doc.fontSize(10).fillColor(colors.textSecondary).font('Helvetica');
      const paymentMethod = payment?.last4 ? `Card ending in ${payment.last4}` : 'Card on file';
      doc.text(`${paymentMethod} • ${formatDate(payment?.created_at || load.delivered_at || new Date())}`, 100, paymentY + 30);

      // Footer
      doc.fontSize(9).fillColor(colors.textSecondary);
      doc.text('Thank you for choosing Hotshot!', 50, 700, { align: 'center' });
      doc.text('Questions? Contact support@hotshot.app', 50, 715, { align: 'center' });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Generate Driver Earnings Statement PDF
 */
async function generateDriverStatement(driver, loads, startDate, endDate) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
      const chunks = [];

      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', async () => {
        const pdfBuffer = Buffer.concat(chunks);
        
        const key = `statements/driver/${driver.id}/STMT-${formatDateFile(startDate)}-${formatDateFile(endDate)}.pdf`;
        
        await s3Client.send(new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: pdfBuffer,
          ContentType: 'application/pdf',
        }));

        const url = `https://${BUCKET}.s3.amazonaws.com/${key}`;
        resolve({ url, key });
      });
      doc.on('error', reject);

      // Header
      doc.fontSize(24).fillColor(colors.primary).text('HOTSHOT', 50, 50);
      doc.fontSize(10).fillColor(colors.textSecondary).text('Driver Earnings Statement', 50, 78);

      // Statement Title
      doc.fontSize(16).fillColor(colors.text).text('EARNINGS STATEMENT', 350, 50, { align: 'right' });
      doc.fontSize(10).fillColor(colors.textSecondary);
      doc.text(`Period: ${formatDate(startDate)} - ${formatDate(endDate)}`, 350, 72, { align: 'right' });

      // Divider
      doc.moveTo(50, 110).lineTo(562, 110).strokeColor(colors.border).stroke();

      // Driver Info
      doc.fontSize(10).fillColor(colors.textSecondary).text('DRIVER', 50, 130);
      doc.fontSize(14).fillColor(colors.text);
      doc.text(`${driver.first_name} ${driver.last_name}`, 50, 148);
      doc.fontSize(10).fillColor(colors.textSecondary);
      doc.text(driver.email, 50, 168);
      doc.text(driver.vehicle_type || 'Vehicle not specified', 50, 183);

      // Summary Box
      const summaryY = 130;
      const totalEarnings = loads.reduce((sum, l) => sum + (parseFloat(l.driver_net_payout || l.driver_payout) || 0), 0);
      const totalLoads = loads.length;
      const totalMiles = loads.reduce((sum, l) => sum + (parseFloat(l.distance_miles) || 0), 0);

      doc.roundedRect(350, summaryY, 212, 70, 5).fillColor('#f0fdf4').fill();
      doc.fontSize(10).fillColor(colors.textSecondary).text('TOTAL EARNINGS', 365, summaryY + 12);
      doc.fontSize(24).fillColor(colors.success).font('Helvetica-Bold');
      doc.text(formatCurrency(totalEarnings), 365, summaryY + 28);
      doc.fontSize(10).fillColor(colors.textSecondary).font('Helvetica');
      doc.text(`${totalLoads} loads • ${totalMiles.toFixed(0)} miles`, 365, summaryY + 55);

      // Loads Table
      const tableY = 230;
      doc.fontSize(10).fillColor(colors.textSecondary).text('COMPLETED LOADS', 50, tableY);

      // Table Header
      doc.rect(50, tableY + 20, 512, 25).fillColor('#f1f5f9').fill();
      doc.fontSize(9).fillColor(colors.textSecondary);
      doc.text('Date', 60, tableY + 28);
      doc.text('Route', 130, tableY + 28);
      doc.text('Miles', 350, tableY + 28);
      doc.text('Gross', 410, tableY + 28);
      doc.text('Net', 480, tableY + 28, { align: 'right' });

      // Table Rows
      let rowY = tableY + 50;
      doc.fontSize(10).fillColor(colors.text);

      loads.slice(0, 15).forEach((load, index) => {
        if (rowY > 650) return; // Don't overflow page
        
        const bgColor = index % 2 === 0 ? '#ffffff' : '#f8fafc';
        doc.rect(50, rowY - 5, 512, 22).fillColor(bgColor).fill();
        
        doc.fillColor(colors.text);
        doc.text(formatDateShort(load.delivered_at || load.completed_at), 60, rowY);
        doc.text(`${load.pickup_city} → ${load.delivery_city}`, 130, rowY);
        doc.text(`${(load.distance_miles || 0).toFixed(0)}`, 350, rowY);
        doc.text(formatCurrency(load.driver_payout || 0), 410, rowY);
        doc.fillColor(colors.success);
        doc.text(formatCurrency(load.driver_net_payout || load.driver_payout || 0), 480, rowY, { align: 'right' });
        
        rowY += 22;
      });

      if (loads.length > 15) {
        doc.fontSize(9).fillColor(colors.textSecondary);
        doc.text(`+ ${loads.length - 15} more loads (see full statement online)`, 60, rowY + 10);
      }

      // Totals
      rowY = Math.max(rowY + 20, 550);
      doc.moveTo(50, rowY).lineTo(562, rowY).strokeColor(colors.border).stroke();
      
      doc.fontSize(12).fillColor(colors.text).font('Helvetica-Bold');
      doc.text('TOTAL EARNINGS', 60, rowY + 15);
      doc.fillColor(colors.success);
      doc.text(formatCurrency(totalEarnings), 480, rowY + 15, { align: 'right' });

      // Footer
      doc.fontSize(9).fillColor(colors.textSecondary).font('Helvetica');
      doc.text('This statement is for informational purposes. Please consult a tax professional.', 50, 700, { align: 'center' });
      doc.text('Questions? Contact support@hotshot.app', 50, 715, { align: 'center' });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Generate Dispatcher Commission Statement PDF
 */
async function generateDispatcherStatement(dispatcher, loads, startDate, endDate) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
      const chunks = [];

      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', async () => {
        const pdfBuffer = Buffer.concat(chunks);
        
        const key = `statements/dispatcher/${dispatcher.id}/COMM-${formatDateFile(startDate)}-${formatDateFile(endDate)}.pdf`;
        
        await s3Client.send(new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: pdfBuffer,
          ContentType: 'application/pdf',
        }));

        const url = `https://${BUCKET}.s3.amazonaws.com/${key}`;
        resolve({ url, key });
      });
      doc.on('error', reject);

      // Header
      doc.fontSize(24).fillColor(colors.primary).text('HOTSHOT', 50, 50);
      doc.fontSize(10).fillColor(colors.textSecondary).text('Dispatcher Commission Statement', 50, 78);

      // Statement Title
      doc.fontSize(16).fillColor(colors.text).text('COMMISSION STATEMENT', 320, 50, { align: 'right' });
      doc.fontSize(10).fillColor(colors.textSecondary);
      doc.text(`Period: ${formatDate(startDate)} - ${formatDate(endDate)}`, 320, 72, { align: 'right' });

      // Divider
      doc.moveTo(50, 110).lineTo(562, 110).strokeColor(colors.border).stroke();

      // Dispatcher Info
      doc.fontSize(10).fillColor(colors.textSecondary).text('DISPATCHER', 50, 130);
      doc.fontSize(14).fillColor(colors.text);
      doc.text(dispatcher.dispatcher_company_name || `${dispatcher.first_name} ${dispatcher.last_name}`, 50, 148);
      doc.fontSize(10).fillColor(colors.textSecondary);
      doc.text(dispatcher.email, 50, 168);

      // Summary Box
      const summaryY = 130;
      const totalCommission = loads.reduce((sum, l) => sum + (parseFloat(l.dispatcher_commission) || 0), 0);
      const totalLoads = loads.length;
      const uniqueDrivers = new Set(loads.map(l => l.driver_id)).size;

      doc.roundedRect(350, summaryY, 212, 70, 5).fillColor('#f0fdf4').fill();
      doc.fontSize(10).fillColor(colors.textSecondary).text('TOTAL COMMISSION', 365, summaryY + 12);
      doc.fontSize(24).fillColor(colors.success).font('Helvetica-Bold');
      doc.text(formatCurrency(totalCommission), 365, summaryY + 28);
      doc.fontSize(10).fillColor(colors.textSecondary).font('Helvetica');
      doc.text(`${totalLoads} loads • ${uniqueDrivers} drivers`, 365, summaryY + 55);

      // Loads Table
      const tableY = 230;
      doc.fontSize(10).fillColor(colors.textSecondary).text('COMPLETED LOADS', 50, tableY);

      // Table Header
      doc.rect(50, tableY + 20, 512, 25).fillColor('#f1f5f9').fill();
      doc.fontSize(9).fillColor(colors.textSecondary);
      doc.text('Date', 60, tableY + 28);
      doc.text('Driver', 130, tableY + 28);
      doc.text('Route', 250, tableY + 28);
      doc.text('Rate', 400, tableY + 28);
      doc.text('Commission', 460, tableY + 28, { align: 'right' });

      // Table Rows
      let rowY = tableY + 50;
      doc.fontSize(10).fillColor(colors.text);

      loads.slice(0, 15).forEach((load, index) => {
        if (rowY > 650) return;
        
        const bgColor = index % 2 === 0 ? '#ffffff' : '#f8fafc';
        doc.rect(50, rowY - 5, 512, 22).fillColor(bgColor).fill();
        
        doc.fillColor(colors.text);
        doc.text(formatDateShort(load.delivered_at || load.completed_at), 60, rowY);
        doc.text(load.driver_name || 'Driver', 130, rowY);
        doc.text(`${load.pickup_city} → ${load.delivery_city}`, 250, rowY);
        doc.text(`${load.dispatcher_commission_rate || 10}%`, 400, rowY);
        doc.fillColor(colors.success);
        doc.text(formatCurrency(load.dispatcher_commission || 0), 460, rowY, { align: 'right' });
        
        rowY += 22;
      });

      if (loads.length > 15) {
        doc.fontSize(9).fillColor(colors.textSecondary);
        doc.text(`+ ${loads.length - 15} more loads`, 60, rowY + 10);
      }

      // Totals
      rowY = Math.max(rowY + 20, 550);
      doc.moveTo(50, rowY).lineTo(562, rowY).strokeColor(colors.border).stroke();
      
      doc.fontSize(12).fillColor(colors.text).font('Helvetica-Bold');
      doc.text('TOTAL COMMISSION', 60, rowY + 15);
      doc.fillColor(colors.success);
      doc.text(formatCurrency(totalCommission), 460, rowY + 15, { align: 'right' });

      // Footer
      doc.fontSize(9).fillColor(colors.textSecondary).font('Helvetica');
      doc.text('This statement is for informational purposes. Please consult a tax professional.', 50, 700, { align: 'center' });
      doc.text('Questions? Contact support@hotshot.app', 50, 715, { align: 'center' });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

// Helper functions
function formatCurrency(amount) {
  return '$' + (parseFloat(amount) || 0).toFixed(2).replace(/\d(?=(\d{3})+\.)/g, '$&,');
}

function formatDate(date) {
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatDateShort(date) {
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function formatDateFile(date) {
  return new Date(date).toISOString().split('T')[0];
}

function getBaseRate(loadType) {
  const rates = { standard: 150, hotshot: 250, emergency: 350 };
  return rates[loadType] || rates.standard;
}

function getPerMileRate(loadType) {
  const rates = { standard: 2.50, hotshot: 3.50, emergency: 4.50 };
  return rates[loadType] || rates.standard;
}

module.exports = {
  generateShipperInvoice,
  generateDriverStatement,
  generateDispatcherStatement,
};
