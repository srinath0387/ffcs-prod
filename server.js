require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const { Parser } = require('json2csv');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { initializeDatabase, dbRun, dbGet, dbAll, dbInsert, getPool, isPostgres } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({ dest: path.join(__dirname, 'uploads/') });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session — use PostgreSQL store in production, memory in dev
function setupSession() {
    const sessionConfig = {
        secret: process.env.SESSION_SECRET || 'ffcs-secret-key-2026',
        resave: false,
        saveUninitialized: false,
        cookie: {
            maxAge: 24 * 60 * 60 * 1000,
            secure: process.env.NODE_ENV === 'production' && process.env.USE_SECURE_COOKIES === 'true',
            httpOnly: true,
        }
    };

    if (isPostgres()) {
        const pgSession = require('connect-pg-simple')(session);
        sessionConfig.store = new pgSession({
            pool: getPool(),
            tableName: 'session',
            createTableIfMissing: true,
        });
        console.log('📦 Using PostgreSQL session store');
    }

    app.use(session(sessionConfig));
}

function requireAuth(req, res, next) {
    if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    next();
}
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.session.user || !roles.includes(req.session.user.role))
            return res.status(403).json({ error: 'Access denied' });
        next();
    };
}

// ============ AUTH ROUTES ============
function setupRoutes() {

    app.post('/api/auth/login', async (req, res) => {
        try {
            const { username, password } = req.body;
            const user = await dbGet('SELECT * FROM users WHERE username = ?', [username]);
            if (!user || !bcrypt.compareSync(password, user.password_hash))
                return res.status(401).json({ error: 'Invalid username or password' });

            req.session.user = { id: user.id, username: user.username, role: user.role, name: user.name };
            res.json({
                success: true,
                user: req.session.user,
                must_change_password: !!user.must_change_password
            });
        } catch (e) {
            console.error("LOGIN ERROR:", e);
            res.status(500).json({ error: 'Login failed' });
        }
    });

    app.post('/api/auth/logout', (req, res) => {
        req.session.destroy();
        res.json({ success: true });
    });

    app.get('/api/auth/me', async (req, res) => {
        if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
        const user = await dbGet('SELECT must_change_password FROM users WHERE id = ?', [req.session.user.id]);
        res.json({ user: req.session.user, must_change_password: !!(user && user.must_change_password) });
    });

    // ============ CHANGE PASSWORD ============

    app.post('/api/auth/change-password', requireAuth, async (req, res) => {
        try {
            const { current_password, new_password } = req.body;
            if (!new_password || new_password.length < 6)
                return res.status(400).json({ error: 'New password must be at least 6 characters' });

            const user = await dbGet('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
            if (!user) return res.status(404).json({ error: 'User not found' });

            if (!bcrypt.compareSync(current_password, user.password_hash))
                return res.status(400).json({ error: 'Current password is incorrect' });

            const newHash = bcrypt.hashSync(new_password, 10);
            await dbRun('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [newHash, user.id]);
            res.json({ success: true, message: 'Password changed successfully!' });
        } catch (e) {
            res.status(500).json({ error: 'Failed to change password' });
        }
    });

    // ============ ADMIN ROUTES ============

    // --- Courses ---
    app.get('/api/admin/courses', requireAuth, requireRole('admin'), async (req, res) => {
        res.json(await dbAll(`
    SELECT c.*, (SELECT COUNT(*) FROM course_faculty cf WHERE cf.course_id = c.id) as faculty_count
    FROM courses c ORDER BY c.code
  `));
    });

    app.post('/api/admin/courses', requireAuth, requireRole('admin'), async (req, res) => {
        try {
            const { code, name, department } = req.body;
            const id = await dbInsert('INSERT INTO courses (code, name, department) VALUES (?, ?, ?)', [code, name, department]);
            res.json({ success: true, id });
        } catch (e) { res.status(400).json({ error: 'Course code already exists' }); }
    });

    app.delete('/api/admin/courses/:id', requireAuth, requireRole('admin'), async (req, res) => {
        const id = parseInt(req.params.id);
        await dbRun('DELETE FROM selections WHERE course_faculty_id IN (SELECT id FROM course_faculty WHERE course_id = ?)', [id]);
        await dbRun('DELETE FROM course_faculty WHERE course_id = ?', [id]);
        await dbRun('DELETE FROM courses WHERE id = ?', [id]);
        res.json({ success: true });
    });

    app.get('/api/admin/courses/:id/faculty', requireAuth, requireRole('admin'), async (req, res) => {
        res.json(await dbAll(`
    SELECT cf.*, u.name as faculty_name, u.username FROM course_faculty cf
    JOIN users u ON cf.faculty_id = u.id WHERE cf.course_id = ?
  `, [parseInt(req.params.id)]));
    });

    app.post('/api/admin/courses/:id/faculty', requireAuth, requireRole('admin'), async (req, res) => {
        try {
            const { faculty_id, max_seats } = req.body;
            await dbInsert('INSERT INTO course_faculty (course_id, faculty_id, max_seats) VALUES (?, ?, ?)',
                [parseInt(req.params.id), faculty_id, max_seats]);
            res.json({ success: true });
        } catch (e) { res.status(400).json({ error: 'Faculty already assigned to this course' }); }
    });

    app.delete('/api/admin/course-faculty/:id', requireAuth, requireRole('admin'), async (req, res) => {
        const id = parseInt(req.params.id);
        await dbRun('DELETE FROM selections WHERE course_faculty_id = ?', [id]);
        await dbRun('DELETE FROM course_faculty WHERE id = ?', [id]);
        res.json({ success: true });
    });

    // --- Faculty ---
    app.get('/api/admin/faculty', requireAuth, requireRole('admin'), async (req, res) => {
        res.json(await dbAll("SELECT id, username, name, email FROM users WHERE role = 'faculty' ORDER BY name"));
    });

    app.post('/api/admin/faculty', requireAuth, requireRole('admin'), async (req, res) => {
        try {
            const { username, password, name, email } = req.body;
            const hash = bcrypt.hashSync(password, 10);
            const id = await dbInsert('INSERT INTO users (username, password_hash, role, name, email, must_change_password) VALUES (?, ?, ?, ?, ?, ?)',
                [username, hash, 'faculty', name, email, 1]);
            res.json({ success: true, id });
        } catch (e) { res.status(400).json({ error: 'Username already exists' }); }
    });

    app.delete('/api/admin/faculty/:id', requireAuth, requireRole('admin'), async (req, res) => {
        const id = parseInt(req.params.id);
        await dbRun('DELETE FROM selections WHERE course_faculty_id IN (SELECT cf.id FROM course_faculty cf WHERE cf.faculty_id = ?)', [id]);
        await dbRun('DELETE FROM course_faculty WHERE faculty_id = ?', [id]);
        await dbRun("DELETE FROM users WHERE id = ? AND role = 'faculty'", [id]);
        res.json({ success: true });
    });

    // --- Students ---
    app.get('/api/admin/students', requireAuth, requireRole('admin'), async (req, res) => {
        const year = req.query.year;
        let sql = "SELECT id, username, name, email, regno, year FROM users WHERE role = 'student'";
        const params = [];
        if (year && year !== 'all') { sql += ' AND year = ?'; params.push(year); }
        sql += ' ORDER BY year DESC, regno, name';
        res.json(await dbAll(sql, params));
    });

    app.post('/api/admin/students', requireAuth, requireRole('admin'), async (req, res) => {
        try {
            const { username, password, name, email, regno, year } = req.body;
            const hash = bcrypt.hashSync(password, 10);
            const id = await dbInsert('INSERT INTO users (username, password_hash, role, name, email, regno, year, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [username, hash, 'student', name, email || '', regno || '', year || '', 1]);
            res.json({ success: true, id });
        } catch (e) { res.status(400).json({ error: 'Username or Reg No already exists' }); }
    });

    app.delete('/api/admin/students/:id', requireAuth, requireRole('admin'), async (req, res) => {
        const id = parseInt(req.params.id);
        await dbRun('DELETE FROM selections WHERE student_id = ?', [id]);
        await dbRun("DELETE FROM users WHERE id = ? AND role = 'student'", [id]);
        res.json({ success: true });
    });

    // --- Bulk Upload ---
    app.post('/api/admin/students/bulk-upload', requireAuth, requireRole('admin'), upload.single('file'), async (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const year = req.body.year || '';
        const defaultPassword = req.body.default_password || 'student123';
        const filePath = req.file.path;

        try {
            const workbook = XLSX.readFile(filePath);
            const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
            let added = 0, skipped = 0;
            const errors = [];
            const hash = bcrypt.hashSync(defaultPassword, 10);

            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const regno = (row['RegNo'] || row['Regno'] || row['regno'] || row['Reg No'] || row['REGNO'] || row['reg_no'] || row['Registration Number'] || '').toString().trim();
                const name = (row['Name'] || row['name'] || row['NAME'] || row['Student Name'] || '').toString().trim();
                const email = (row['Email'] || row['email'] || row['EMAIL'] || row['Mail'] || '').toString().trim();

                if (!regno || !name) { skipped++; errors.push(`Row ${i + 2}: Missing RegNo or Name`); continue; }
                const username = regno.toLowerCase().replace(/\s/g, '');
                const existing = await dbGet('SELECT id FROM users WHERE username = ? OR regno = ?', [username, regno]);
                if (existing) { skipped++; errors.push(`Row ${i + 2}: ${regno} already exists`); continue; }

                try {
                    await dbInsert('INSERT INTO users (username, password_hash, role, name, email, regno, year, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                        [username, hash, 'student', name, email, regno, year, 1]);
                    added++;
                } catch (e) { skipped++; errors.push(`Row ${i + 2}: ${e.message}`); }
            }

            fs.unlinkSync(filePath);
            res.json({ success: true, added, skipped, total: rows.length, errors: errors.slice(0, 20) });
        } catch (e) {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            res.status(400).json({ error: 'Failed to parse file: ' + e.message });
        }
    });

    app.get('/api/admin/students/template', requireAuth, requireRole('admin'), (req, res) => {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=student_upload_template.csv');
        res.send('RegNo,Name,Email\n22BCE1001,John Doe,john@example.com\n22BCE1002,Jane Smith,jane@example.com\n');
    });

    app.get('/api/admin/students/years', requireAuth, requireRole('admin'), async (req, res) => {
        const years = await dbAll("SELECT DISTINCT year FROM users WHERE role = 'student' AND year IS NOT NULL AND year != '' ORDER BY year DESC");
        res.json(years.map(y => y.year));
    });

    // --- Selections ---
    app.get('/api/admin/selections', requireAuth, requireRole('admin'), async (req, res) => {
        res.json(await dbAll(`
    SELECT s.id, s.selected_at, u.name as student_name, u.username as student_username, u.regno as student_regno,
      c.code as course_code, c.name as course_name, f.name as faculty_name, f.username as faculty_username
    FROM selections s JOIN users u ON s.student_id = u.id
    JOIN course_faculty cf ON s.course_faculty_id = cf.id
    JOIN courses c ON cf.course_id = c.id JOIN users f ON cf.faculty_id = f.id
    ORDER BY c.code, f.name, u.name
  `));
    });

    // --- Export ---
    app.get('/api/admin/export/:format', requireAuth, requireRole('admin'), async (req, res) => {
        const selections = await dbAll(`
    SELECT u.regno as "Reg No", u.name as "Student Name", c.code as "Course Code",
      c.name as "Course Name", f.name as "Faculty Name", s.selected_at as "Selected At"
    FROM selections s JOIN users u ON s.student_id = u.id
    JOIN course_faculty cf ON s.course_faculty_id = cf.id
    JOIN courses c ON cf.course_id = c.id JOIN users f ON cf.faculty_id = f.id
    ORDER BY c.code, f.name, u.name
  `);

        const fmt = req.params.format;
        if (fmt === 'csv') {
            const parser = new Parser({ fields: ['Reg No', 'Student Name', 'Course Code', 'Course Name', 'Faculty Name', 'Selected At'] });
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=ffcs_selections.csv');
            res.send(parser.parse(selections));
        } else if (fmt === 'excel') {
            const wb = new ExcelJS.Workbook();
            const sh = wb.addWorksheet('Selections');
            sh.columns = [
                { header: 'Reg No', key: 'Reg No', width: 15 }, { header: 'Student Name', key: 'Student Name', width: 25 },
                { header: 'Course Code', key: 'Course Code', width: 12 }, { header: 'Course Name', key: 'Course Name', width: 35 },
                { header: 'Faculty Name', key: 'Faculty Name', width: 25 }, { header: 'Selected At', key: 'Selected At', width: 22 },
            ];
            sh.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
            sh.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
            selections.forEach(r => sh.addRow(r));
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', 'attachment; filename=ffcs_selections.xlsx');
            await wb.xlsx.write(res); res.end();
        } else if (fmt === 'pdf') {
            const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', 'attachment; filename=ffcs_selections.pdf');
            doc.pipe(res);
            doc.fontSize(20).fillColor('#4F46E5').text('FFCS - Faculty Selection Report', { align: 'center' });
            doc.moveDown(0.5);
            doc.fontSize(10).fillColor('#666').text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
            doc.moveDown(1);
            const headers = ['Reg No', 'Student Name', 'Course Code', 'Course Name', 'Faculty Name', 'Selected At'];
            const cw = [80, 130, 75, 160, 130, 130];
            let y = doc.y, x = 40;
            doc.fontSize(9).rect(x, y, cw.reduce((a, b) => a + b, 0), 20).fill('#4F46E5');
            y += 5;
            headers.forEach((h, i) => { doc.fillColor('#FFF').text(h, x + 5, y, { width: cw[i] - 10, lineBreak: false }); x += cw[i]; });
            y += 20; doc.fillColor('#333');
            selections.forEach((row, idx) => {
                if (y > 520) { doc.addPage(); y = 40; }
                x = 40;
                if (idx % 2 === 0) { doc.rect(x, y - 3, cw.reduce((a, b) => a + b, 0), 18).fill('#F3F4F6'); doc.fillColor('#333'); }
                [row['Reg No'], row['Student Name'], row['Course Code'], row['Course Name'], row['Faculty Name'], row['Selected At']]
                    .forEach((v, i) => { doc.fontSize(8).text(v || '', x + 5, y, { width: cw[i] - 10, lineBreak: false }); x += cw[i]; });
                y += 18;
            });
            if (!selections.length) doc.fontSize(12).fillColor('#999').text('No selections yet.', 40, y + 20, { align: 'center' });
            doc.end();
        } else { res.status(400).json({ error: 'Use csv, excel, or pdf' }); }
    });

    // ============ FACULTY ROUTES ============

    app.get('/api/faculty/courses', requireAuth, requireRole('faculty'), async (req, res) => {
        const courses = await dbAll(`
    SELECT cf.id as course_faculty_id, cf.max_seats, cf.enrolled_count,
      c.code, c.name as course_name, c.department
    FROM course_faculty cf JOIN courses c ON cf.course_id = c.id
    WHERE cf.faculty_id = ? ORDER BY c.code
  `, [req.session.user.id]);

        for (const course of courses) {
            course.students = await dbAll(`
      SELECT u.name, u.username, u.email, u.regno, s.selected_at
      FROM selections s JOIN users u ON s.student_id = u.id
      WHERE s.course_faculty_id = ? ORDER BY u.name
    `, [course.course_faculty_id]);
        }
        res.json(courses);
    });

    // ============ STUDENT ROUTES ============

    app.get('/api/student/courses', requireAuth, requireRole('student'), async (req, res) => {
        const courses = await dbAll('SELECT * FROM courses ORDER BY code');
        for (const course of courses) {
            course.faculty = await dbAll(`
      SELECT cf.id as course_faculty_id, cf.max_seats, cf.enrolled_count,
        u.name as faculty_name, u.username as faculty_username,
        CASE WHEN cf.enrolled_count >= cf.max_seats THEN 1 ELSE 0 END as is_full,
        (SELECT COUNT(*) FROM selections s WHERE s.student_id = ? AND s.course_faculty_id = cf.id) as already_selected
      FROM course_faculty cf JOIN users u ON cf.faculty_id = u.id
      WHERE cf.course_id = ? ORDER BY u.name
    `, [req.session.user.id, course.id]);
            course.has_selection = course.faculty.some(f => f.already_selected > 0);
        }
        res.json(courses);
    });

    app.post('/api/student/select', requireAuth, requireRole('student'), async (req, res) => {
        try {
            const { course_faculty_id } = req.body;
            const cf = await dbGet('SELECT cf.*, c.name as course_name FROM course_faculty cf JOIN courses c ON cf.course_id = c.id WHERE cf.id = ?', [course_faculty_id]);
            if (!cf) return res.status(404).json({ error: 'Slot not found' });
            if (cf.enrolled_count >= cf.max_seats) return res.status(400).json({ error: 'Slots are full for this faculty!' });

            const existing = await dbGet('SELECT s.id FROM selections s JOIN course_faculty cf2 ON s.course_faculty_id = cf2.id WHERE s.student_id = ? AND cf2.course_id = ?',
                [req.session.user.id, cf.course_id]);
            if (existing) return res.status(400).json({ error: 'You already selected a faculty for this course' });

            await dbInsert('INSERT INTO selections (student_id, course_faculty_id) VALUES (?, ?)', [req.session.user.id, course_faculty_id]);
            await dbRun('UPDATE course_faculty SET enrolled_count = enrolled_count + 1 WHERE id = ?', [course_faculty_id]);
            res.json({ success: true, message: 'Faculty selected successfully!' });
        } catch (e) { res.status(400).json({ error: 'Selection failed' }); }
    });

    app.delete('/api/student/selections/:id', requireAuth, requireRole('student'), async (req, res) => {
        const sel = await dbGet('SELECT s.*, cf.id as cf_id FROM selections s JOIN course_faculty cf ON s.course_faculty_id = cf.id WHERE s.id = ? AND s.student_id = ?',
            [parseInt(req.params.id), req.session.user.id]);
        if (!sel) return res.status(404).json({ error: 'Selection not found' });
        await dbRun('DELETE FROM selections WHERE id = ?', [sel.id]);
        await dbRun('UPDATE course_faculty SET enrolled_count = enrolled_count - 1 WHERE id = ?', [sel.cf_id]);
        res.json({ success: true });
    });

    app.get('/api/student/selections', requireAuth, requireRole('student'), async (req, res) => {
        res.json(await dbAll(`
    SELECT s.id, s.selected_at, c.code, c.name as course_name,
      u.name as faculty_name, cf.max_seats, cf.enrolled_count
    FROM selections s JOIN course_faculty cf ON s.course_faculty_id = cf.id
    JOIN courses c ON cf.course_id = c.id JOIN users u ON cf.faculty_id = u.id
    WHERE s.student_id = ? ORDER BY c.code
  `, [req.session.user.id]));
    });

    // ============ PAGES ============
    app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
    app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
    app.get('/faculty', (req, res) => res.sendFile(path.join(__dirname, 'public', 'faculty.html')));
    app.get('/student', (req, res) => res.sendFile(path.join(__dirname, 'public', 'student.html')));
} // end of setupRoutes

// ============ START ============
async function start() {
    await initializeDatabase();
    setupSession();
    setupRoutes();
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

    app.listen(PORT, () => {
        console.log(`\n🎓 FFCS System running at http://localhost:${PORT}`);
        console.log(`   Mode: ${isPostgres() ? 'PostgreSQL (production)' : 'SQLite (local dev)'}`);
        console.log(`📋 Admin: admin / admin123\n`);
    });
}

start().catch(console.error);
