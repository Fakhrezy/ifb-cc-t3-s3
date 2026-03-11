require('dotenv').config();
const express = require('express');
const mysql2 = require('mysql2/promise');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');
const multerS3 = require('multer-s3');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// AWS S3 Config (SDK v3)
const s3 = new S3Client({
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  region: process.env.AWS_REGION
});

// MySQL Connection Pool
const pool = mysql2.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: 10
});

// Init Database & Table
async function initDB() {
  const conn = await pool.getConnection();
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME}\``);
  await conn.query(`USE \`${process.env.DB_NAME}\``);
  await conn.query(`
    CREATE TABLE IF NOT EXISTS files (
      id INT AUTO_INCREMENT PRIMARY KEY,
      file_name VARCHAR(255) NOT NULL,
      file_url TEXT NOT NULL,
      file_size VARCHAR(50),
      file_type VARCHAR(100),
      upload_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  conn.release();
  console.log('Database & table ready!');
}

// Multer S3 Upload (SDK v3)
const upload = multer({
  storage: multerS3({
    s3,
    bucket: process.env.S3_BUCKET,
    metadata: (req, file, cb) => cb(null, { fieldName: file.fieldname }),
    key: (req, file, cb) => {
      const uniqueName = Date.now() + '-' + file.originalname;
      cb(null, uniqueName);
    }
  })
});

// ===== ROUTES =====

// Upload file
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const { originalname, size, mimetype, location } = req.file;
    const fileSizeKB = (size / 1024).toFixed(2) + ' KB';

    const conn = await pool.getConnection();
    await conn.query(`USE \`${process.env.DB_NAME}\``);
    await conn.query(
      'INSERT INTO files (file_name, file_url, file_size, file_type) VALUES (?, ?, ?, ?)',
      [originalname, location, fileSizeKB, mimetype]
    );
    conn.release();

    res.json({ success: true, message: 'File berhasil diupload!', url: location });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ success: false, message: 'Upload gagal', error: err.message });
  }
});

// List semua file
app.get('/files', async (req, res) => {
  try {
    const conn = await pool.getConnection();
    await conn.query(`USE \`${process.env.DB_NAME}\``);
    const [rows] = await conn.query('SELECT * FROM files ORDER BY upload_date DESC');
    conn.release();
    res.json(rows);
  } catch (err) {
    console.error('List error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete file
app.delete('/files/:id', async (req, res) => {
  try {
    const conn = await pool.getConnection();
    await conn.query(`USE \`${process.env.DB_NAME}\``);
    const [rows] = await conn.query('SELECT * FROM files WHERE id = ?', [req.params.id]);

    if (rows.length === 0) {
      conn.release();
      return res.status(404).json({ message: 'File tidak ditemukan' });
    }

    const fileUrl = rows[0].file_url;
    const key = fileUrl.split('.com/')[1];

    // Hapus dari S3 (SDK v3)
    await s3.send(new DeleteObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key
    }));

    // Hapus dari DB
    await conn.query('DELETE FROM files WHERE id = ?', [req.params.id]);
    conn.release();

    res.json({ success: true, message: 'File berhasil dihapus' });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Start server
initDB().then(() => {
  app.listen(process.env.PORT, () => {
    console.log(`Server berjalan di port ${process.env.PORT}`);
  });
}).catch(err => {
  console.error('Gagal inisialisasi database:', err.message);
  process.exit(1);
});