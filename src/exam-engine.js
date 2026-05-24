/**
 * src/exam-engine.js
 * RF-04: Toda la lógica de negocio permanece en el backend.
 * El cliente NUNCA recibe qué opción es correcta.
 */

'use strict';

class ExamEngine {
  constructor(db) {
    this.db = db;
    this.currentExamId = null;
    this._exams = {}; // cache en memoria
    this._loadAllExams();
  }

  _loadAllExams() {
    const rows = this.db.getAllExams();
    rows.forEach(row => {
      const full = this.db.getExamRaw(row.id);
      if (full) {
        const parsed = JSON.parse(full.questions);
        this._exams[row.id] = {
          id: row.id,
          title: full.title,
          questions: parsed  // incluye campo `correct` — NUNCA se envía al cliente
        };
      }
    });
    console.log(`[ExamEngine] ${Object.keys(this._exams).length} examen(s) cargado(s).`);
    // Auto-seleccionar el primero
    const keys = Object.keys(this._exams);
    if (keys.length > 0) this.currentExamId = keys[0];
  }

  getExam(examId) {
    return this._exams[examId] || null;
  }

  activateExam(examId) {
    if (this._exams[examId]) {
      this.currentExamId = examId;
      return true;
    }
    return false;
  }

  deactivateExam() {
    // No borramos currentExamId para permitir reconexiones
  }

  /**
   * Calcula el score de un alumno dado su mapa de respuestas.
   * RF-04: ejecutado 100% en servidor.
   * @param {string} examId
   * @param {Object} answers - { questionIdx: optionIdx }
   * @returns {number} porcentaje 0-100
   */
  calculateScore(examId, answers) {
    const exam = this._exams[examId];
    if (!exam) return 0;
    let correct = 0;
    exam.questions.forEach((q, idx) => {
      if (answers[idx] === q.correct) correct++;
    });
    return Math.round((correct / exam.questions.length) * 100);
  }

  getStatus() {
    return {
      currentExamId: this.currentExamId,
      availableExams: Object.values(this._exams).map(e => ({
        id: e.id,
        title: e.title,
        questionCount: e.questions.length
      }))
    };
  }

  /**
   * Agrega un nuevo examen en runtime y persiste en SQLite.
   */
  addExam(id, title, questions) {
    this.db.db.prepare('INSERT OR REPLACE INTO exams (id, title, questions) VALUES (?, ?, ?)')
      .run(id, title, JSON.stringify(questions));
    this._exams[id] = { id, title, questions };
    return true;
  }
}

module.exports = ExamEngine;
