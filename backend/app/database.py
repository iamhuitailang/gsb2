"""SQLAlchemy engine / session setup and ORM models."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    create_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker
from sqlalchemy.types import TypeDecorator

from .config import DATABASE_URL, DB_PATH


class UTCDateTime(TypeDecorator):
    """DateTime that round-trips timezone-aware values on SQLite.

    SQLite has no native datetime type and the default dialect drops tzinfo
    (and shifts to the machine's local zone). We normalize every value to naive
    UTC on the way in and re-attach UTC on the way out, so timestamp comparisons
    and date filters are independent of the server's local timezone.
    """

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("only timezone-aware datetimes may be stored")
        return value.astimezone(timezone.utc).replace(tzinfo=None)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return value.replace(tzinfo=timezone.utc)


class Base(DeclarativeBase):
    pass


engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
    pool_pre_ping=True,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    Base.metadata.create_all(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Event(Base):
    """One raw game event as received.

    The row is immutable once stored: re-derivation always starts from these
    rows so that identical raw data + rule version yields identical results.
    """

    __tablename__ = "events"
    __table_args__ = (
        UniqueConstraint("event_id", name="uq_events_event_id"),
        Index("ix_events_session", "session_id"),
        Index("ix_events_player", "player_id"),
        Index("ix_events_session_seq", "session_id", "sequence"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_id: Mapped[str] = mapped_column(String(128), nullable=False)
    session_id: Mapped[str] = mapped_column(String(128), nullable=False)
    player_id: Mapped[str] = mapped_column(String(128), nullable=False)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    schema_version: Mapped[str] = mapped_column(String(16), nullable=False)
    payload_json: Mapped[str] = mapped_column(Text, nullable=False)

    # Ingestion bookkeeping (not trusted client data).
    received_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    # Whether the event was accepted as canonical for its event_id. A row only
    # exists when the event passed validation, so this is always true here;
    # duplicates are rejected before insert and reported per-item.
    is_canonical: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class SessionSummary(Base):
    """Derived per-session result produced by the rules engine."""

    __tablename__ = "session_summaries"
    __table_args__ = (
        UniqueConstraint("session_id", "rules_version", name="uq_summary_session_rules"),
        Index("ix_summaries_status", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(String(128), nullable=False)
    rules_version: Mapped[str] = mapped_column(String(32), nullable=False)
    schema_version: Mapped[str] = mapped_column(String(16), nullable=False)

    status: Mapped[str] = mapped_column(String(32), nullable=False)  # open | completed
    outcome: Mapped[str | None] = mapped_column(String(32), nullable=True)  # win|loss|draw|None
    player_id: Mapped[str] = mapped_column(String(128), nullable=False)

    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)

    total_events: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    key_action_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    completeness_rate: Mapped[float | None] = mapped_column(Float, nullable=True)

    anomaly_counts: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    metrics_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    timeline_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    result_hash: Mapped[str] = mapped_column(String(64), nullable=False)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=utcnow, onupdate=utcnow, nullable=False
    )
