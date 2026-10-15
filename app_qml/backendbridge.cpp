#include "backendbridge.h"

#include <QCoreApplication>
#include <QDir>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonParseError>
#include <QJsonValue>
#include <QProcessEnvironment>
#include <QTimer>

namespace {
constexpr int kMaxLineBytes = 4 * 1024 * 1024;   // 后端单行上限 1 MiB，这里留余量后强断
constexpr int kMaxStderrTail = 120;
constexpr int kInternalId = 0;                   // 桥自己发的请求（app.info）
}

BackendBridge::BackendBridge(QObject *parent)
    : QObject(parent)
{
    m_script = locateScript();
    m_node = locateNode();

    const QString override = qEnvironmentVariable("SHL_CONFIG_DIR");
    const QString appData = qEnvironmentVariable("APPDATA");
    m_configDir = !override.isEmpty()
                      ? override
                      : (appData.isEmpty() ? QDir::homePath() + QStringLiteral("/.stronghold-link")
                                           : appData + QStringLiteral("/stronghold-link"));
    m_logPath = m_configDir + QStringLiteral("/startup.log");
}

BackendBridge::~BackendBridge()
{
    if (m_proc) {
        m_shuttingDown = true;
        m_proc->disconnect(this);
        if (m_proc->state() != QProcess::NotRunning) {
            m_proc->kill();
            m_proc->waitForFinished(2000);
        }
    }
}

QString BackendBridge::locateScript()
{
    const QString fromEnv = qEnvironmentVariable("SHL_BACKEND_SCRIPT");
    if (!fromEnv.isEmpty() && QFileInfo::exists(fromEnv))
        return QFileInfo(fromEnv).absoluteFilePath();

    const QString appDir = QCoreApplication::applicationDirPath();
    const QStringList candidates = {
        appDir + QStringLiteral("/backend/stronghold-backend.cjs"),
        appDir + QStringLiteral("/../backend/stronghold-backend.cjs"),
        appDir + QStringLiteral("/../../backend/stronghold-backend.cjs"),
        appDir + QStringLiteral("/../../../backend/stronghold-backend.cjs"),
        // qmake 默认把产物放进 build/release/release/，比源码根深四层；
        // 少这一条时开发构建会静默 ENOSCRIPT（找不到后端脚本），实测踩到过。
        appDir + QStringLiteral("/../../../../backend/stronghold-backend.cjs"),
    };
    for (const QString &c : candidates) {
        const QFileInfo fi(c);
        if (fi.exists())
            return fi.absoluteFilePath();
    }
    return QString();
}

QString BackendBridge::locateNode()
{
    const QString fromEnv = qEnvironmentVariable("SHL_NODE");
    if (!fromEnv.isEmpty() && QFileInfo::exists(fromEnv))
        return QFileInfo(fromEnv).absoluteFilePath();

    const QString appDir = QCoreApplication::applicationDirPath();
    const QStringList candidates = {
        appDir + QStringLiteral("/node/node.exe"),
        appDir + QStringLiteral("/node.exe"),
        appDir + QStringLiteral("/../node/node.exe"),
    };
    for (const QString &c : candidates) {
        const QFileInfo fi(c);
        if (fi.exists())
            return fi.absoluteFilePath();
    }
    return QStringLiteral("node");   // 交给 PATH 解析
}

void BackendBridge::start()
{
    if (m_proc)
        return;
    if (m_script.isEmpty()) {
        fail(QStringLiteral("ENOSCRIPT"),
             QStringLiteral("找不到后端脚本 stronghold-backend.cjs（可用 SHL_BACKEND_SCRIPT 指定）"));
        return;
    }

    m_proc = new QProcess(this);
    m_proc->setProgram(m_node);
    m_proc->setArguments({m_script});
    m_proc->setWorkingDirectory(QFileInfo(m_script).absolutePath());
    m_proc->setProcessChannelMode(QProcess::SeparateChannels);

    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.remove(QStringLiteral("ELECTRON_RUN_AS_NODE"));
    if (!qEnvironmentVariable("SHL_CONFIG_DIR").isEmpty())
        env.insert(QStringLiteral("SHL_CONFIG_DIR"), m_configDir);
    m_proc->setProcessEnvironment(env);

    connect(m_proc, &QProcess::readyReadStandardOutput, this, &BackendBridge::onStdout);
    connect(m_proc, &QProcess::readyReadStandardError, this, &BackendBridge::onStderr);
    connect(m_proc, qOverload<int, QProcess::ExitStatus>(&QProcess::finished), this, &BackendBridge::onFinished);
    connect(m_proc, &QProcess::errorOccurred, this, &BackendBridge::onProcError);

    m_proc->start();
    if (!m_proc->waitForStarted(15000)) {
        fail(QStringLiteral("ESPAWN"),
             QStringLiteral("后端进程启动失败：%1（node=%2）").arg(m_proc->errorString(), m_node));
        m_proc->deleteLater();
        m_proc = nullptr;
        return;
    }

    m_running = true;
    emit runningChanged();
    emit logLine(QStringLiteral("后端已启动：%1 %2").arg(m_node, m_script));

    for (const QByteArray &line : m_queue)
        m_proc->write(line);
    m_queue.clear();

    sendInternal(QStringLiteral("app.info"));
}

void BackendBridge::stop()
{
    if (!m_proc || m_shuttingDown)
        return;
    m_shuttingDown = true;
    writeLine(QByteArray("{\"type\":\"request\",\"id\":") + QByteArray::number(m_nextId++)
              + QByteArray(",\"method\":\"app.shutdown\",\"params\":{}}\n"));
    QTimer::singleShot(4000, this, [this]() {
        if (m_proc && m_proc->state() != QProcess::NotRunning) {
            emit logLine(QStringLiteral("后端未在 4 秒内退出，强制结束"));
            m_proc->kill();
        }
    });
}

int BackendBridge::call(const QString &method, const QJsonObject &params)
{
    const int id = m_nextId++;
    QJsonObject req;
    req.insert(QStringLiteral("type"), QStringLiteral("request"));
    req.insert(QStringLiteral("id"), id);
    req.insert(QStringLiteral("method"), method);
    req.insert(QStringLiteral("params"), params);
    const QByteArray line = QJsonDocument(req).toJson(QJsonDocument::Compact) + '\n';

    if (!m_proc)
        start();
    if (m_running && m_proc)
        m_proc->write(line);
    else
        m_queue.append(line);
    return id;
}

QString BackendBridge::jsonOf(const QJsonObject &obj) const
{
    return QString::fromUtf8(QJsonDocument(obj).toJson(QJsonDocument::Compact));
}

void BackendBridge::sendInternal(const QString &method)
{
    if (m_identifySent)
        return;
    m_identifySent = true;
    QJsonObject req;
    req.insert(QStringLiteral("type"), QStringLiteral("request"));
    req.insert(QStringLiteral("id"), kInternalId);
    req.insert(QStringLiteral("method"), method);
    req.insert(QStringLiteral("params"), QJsonObject());
    writeLine(QJsonDocument(req).toJson(QJsonDocument::Compact) + '\n');
}

void BackendBridge::writeLine(const QByteArray &line)
{
    if (m_proc && m_running)
        m_proc->write(line);
    else
        m_queue.append(line);
}

void BackendBridge::onStdout()
{
    if (!m_proc)
        return;
    m_buf += m_proc->readAllStandardOutput();
    if (m_buf.size() > kMaxLineBytes) {
        m_buf.clear();
        fail(QStringLiteral("EHUGE"),
             QStringLiteral("后端 stdout 单行超过 4 MiB，疑似协议被污染（stdout 只允许 JSONL）"));
        return;
    }
    int idx;
    while ((idx = m_buf.indexOf('\n')) >= 0) {
        const QByteArray line = m_buf.left(idx);
        m_buf.remove(0, idx + 1);
        handleLine(line);
    }
}

void BackendBridge::onStderr()
{
    if (!m_proc)
        return;
    const QByteArray raw = m_proc->readAllStandardError();
    for (const QByteArray &part : raw.split('\n')) {
        const QString line = QString::fromUtf8(part).trimmed();
        if (!line.isEmpty())
            noteStderr(line);
    }
}

void BackendBridge::noteStderr(const QString &line)
{
    m_stderrTail.append(line);
    while (m_stderrTail.size() > kMaxStderrTail)
        m_stderrTail.removeFirst();
    emit logLine(line);
}

void BackendBridge::handleLine(const QByteArray &raw)
{
    const QByteArray line = raw.trimmed();
    if (line.isEmpty())
        return;

    QJsonParseError err{};
    const QJsonDocument doc = QJsonDocument::fromJson(line, &err);
    if (err.error != QJsonParseError::NoError || !doc.isObject()) {
        emit logLine(QStringLiteral("后端 stdout 出现非协议内容：%1").arg(QString::fromUtf8(line.left(400))));
        return;
    }

    const QJsonObject obj = doc.object();
    const QString type = obj.value(QStringLiteral("type")).toString();

    if (type == QLatin1String("response")) {
        const QJsonValue idValue = obj.value(QStringLiteral("id"));
        const int id = idValue.isDouble() ? idValue.toInt() : -1;
        const bool ok = obj.value(QStringLiteral("ok")).toBool();
        const QJsonObject result = obj.value(QStringLiteral("result")).toObject();
        const QJsonObject error = obj.value(QStringLiteral("error")).toObject();
        if (ok)
            applyIdentity(result);
        if (id == kInternalId)
            setReady(true);   // 桥自己的 app.info 回来了 ⇒ 后端可用
        emit response(id, ok, result,
                      error.value(QStringLiteral("code")).toString(),
                      error.value(QStringLiteral("message")).toString());
        return;
    }

    if (type == QLatin1String("event")) {
        const QString name = obj.value(QStringLiteral("name")).toString();
        const QJsonObject payload = obj.value(QStringLiteral("payload")).toObject();
        if (name == QLatin1String("backend.error"))
            fail(payload.value(QStringLiteral("code")).toString(QStringLiteral("ECRASH")),
                 payload.value(QStringLiteral("message")).toString());
        emit backendEvent(name, payload);
        return;
    }

    emit logLine(QStringLiteral("后端 stdout 出现未知消息：%1").arg(QString::fromUtf8(line.left(400))));
}

void BackendBridge::applyIdentity(const QJsonObject &obj)
{
    const QString version = obj.value(QStringLiteral("version")).toString();
    if (!version.isEmpty() && version != m_version) {
        m_version = version;
        emit versionChanged();
        setReady(true);
    }
    const QString dir = obj.value(QStringLiteral("configDir")).toString();
    if (!dir.isEmpty() && dir != m_configDir) {
        m_configDir = dir;
        emit configDirChanged();
    }
}

void BackendBridge::setReady(bool value)
{
    if (m_ready == value)
        return;
    m_ready = value;
    emit readyChanged();
}

void BackendBridge::fail(const QString &code, const QString &message)
{
    m_lastError = message;
    emit lastErrorChanged();
    emit backendError(code, message);
}

void BackendBridge::onProcError(QProcess::ProcessError error)
{
    if (error == QProcess::FailedToStart)
        fail(QStringLiteral("ESPAWN"), QStringLiteral("无法启动后端进程：%1").arg(m_node));
    else if (error == QProcess::Crashed)
        fail(QStringLiteral("ECRASH"), QStringLiteral("后端进程崩溃"));
}

void BackendBridge::onFinished(int exitCode, QProcess::ExitStatus status)
{
    Q_UNUSED(status)
    m_running = false;
    emit runningChanged();
    if (!m_shuttingDown) {
        fail(QStringLiteral("EEXIT"),
             QStringLiteral("后端进程意外退出（退出码 %1）").arg(exitCode));
    } else {
        emit logLine(QStringLiteral("后端已退出（退出码 %1）").arg(exitCode));
    }
    if (m_proc) {
        m_proc->deleteLater();
        m_proc = nullptr;
    }
}
