// Stronghold Link — Qt/QML 前端与 Node 后端的桥
// 只做三件事：拉起常驻 Node 子进程、按 JSON Lines 协议收发、把响应/事件转成 Qt 信号。
// 协议见 docs/QML_MIGRATION_PLAN.md：stdout 只有协议 JSONL，诊断走 stderr。
#pragma once

#include <QByteArray>
#include <QJsonObject>
#include <QList>
#include <QObject>
#include <QProcess>
#include <QString>
#include <QStringList>

class BackendBridge : public QObject
{
    Q_OBJECT
    Q_PROPERTY(bool ready READ ready NOTIFY readyChanged)
    Q_PROPERTY(bool running READ running NOTIFY runningChanged)
    Q_PROPERTY(QString version READ version NOTIFY versionChanged)
    Q_PROPERTY(QString configDir READ configDir NOTIFY configDirChanged)
    Q_PROPERTY(QString backendPath READ backendPath CONSTANT)
    Q_PROPERTY(QString nodePath READ nodePath CONSTANT)
    Q_PROPERTY(QString logPath READ logPath CONSTANT)
    Q_PROPERTY(QString lastError READ lastError NOTIFY lastErrorChanged)

public:
    explicit BackendBridge(QObject *parent = nullptr);
    ~BackendBridge() override;

    bool ready() const { return m_ready; }
    bool running() const { return m_running; }
    QString version() const { return m_version; }
    QString configDir() const { return m_configDir; }
    QString backendPath() const { return m_script; }
    QString nodePath() const { return m_node; }
    QString logPath() const { return m_logPath; }
    QString lastError() const { return m_lastError; }

    // 拉起后端（幂等）。QML 侧通常在 Component.onCompleted 调用。
    Q_INVOKABLE void start();
    // 让后端优雅停机（app.shutdown），超时兜底 kill。
    Q_INVOKABLE void stop();
    // 发一条请求，返回请求 id（响应通过 response 信号配对）。未就绪时排队。
    Q_INVOKABLE int call(const QString &method, const QJsonObject &params = QJsonObject());
    // 诊断页用：最近的后端 stderr 行（倒序，最多 120 行）。
    Q_INVOKABLE QStringList stderrTail() const { return m_stderrTail; }
    Q_INVOKABLE QString jsonOf(const QJsonObject &obj) const;

signals:
    void readyChanged();
    void runningChanged();
    void versionChanged();
    void configDirChanged();
    void lastErrorChanged();
    void response(int id, bool ok, const QJsonObject &result, const QString &code, const QString &message);
    // 注意：不要叫 event —— 会隐藏 QObject::event(QEvent*)，触发 -Woverloaded-virtual。
    void backendEvent(const QString &name, const QJsonObject &payload);
    void backendError(const QString &code, const QString &message);
    void logLine(const QString &line);

private slots:
    void onStdout();
    void onStderr();
    void onFinished(int exitCode, QProcess::ExitStatus status);
    void onProcError(QProcess::ProcessError error);

private:
    static QString locateScript();
    static QString locateNode();
    void sendInternal(const QString &method);
    void writeLine(const QByteArray &line);
    void handleLine(const QByteArray &line);
    void applyIdentity(const QJsonObject &obj);
    void setReady(bool value);
    void fail(const QString &code, const QString &message);
    void noteStderr(const QString &line);

    QProcess *m_proc = nullptr;
    QByteArray m_buf;
    QList<QByteArray> m_queue;
    QStringList m_stderrTail;
    int m_nextId = 1;
    bool m_ready = false;
    bool m_running = false;
    bool m_shuttingDown = false;
    bool m_identifySent = false;
    QString m_version;
    QString m_configDir;
    QString m_script;
    QString m_node;
    QString m_logPath;
    QString m_lastError;
};
